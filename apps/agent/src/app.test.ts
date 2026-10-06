import { createHmac, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import { DelegationRepository } from "./modules/delegations/index.js";
import { ActionRepository, type ExecutorService } from "./modules/executor/index.js";
import { GrantRepository } from "./modules/grants/index.js";
import type { Db } from "./shared/db/database.js";
import { createTokenVerifier } from "./shared/middlewares/requireDynamicUser.js";
import {
  DYNAMIC_SECRET,
  ENVIRONMENT_ID,
  FakeChain,
  FakeDynamic,
  FakeMcp,
  KEY_SHARE,
  MARKET,
  NOW,
  OTHER_USER_ID,
  OTHER_WALLET,
  REVIEW_SECRET,
  SELIO_SECRET,
  STORAGE_KEY,
  USDC,
  USER_ID,
  VAULT,
  WALLET,
  WALLET_API_KEY,
  WALLET_ID,
  WALLET_LC,
  envelopeOf,
  seedDelegation,
  seedGrant,
  silentLogger,
  testDb,
} from "./testing/fakes.js";

const DAY = 86_400_000;
const reviewKeys = generateKeyPairSync("ed25519");

let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] });
  otherKey = (await generateKeyPair("RS256")).privateKey;
});

interface TokenOptions {
  issuer?: string;
  sub?: string;
  key?: CryptoKey;
  exp?: number | string;
}

function token(claims: Record<string, unknown> = {}, options: TokenOptions = {}) {
  return new SignJWT({
    environment_id: ENVIRONMENT_ID,
    scope: "user:basic",
    verified_credentials: [
      { email: "user@example.com", format: "email" },
      { address: WALLET, chain: "eip155", format: "blockchain", wallet_name: "dynamicwaas" },
    ],
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? `app.dynamicauth.com/${ENVIRONMENT_ID}`)
    .setSubject(options.sub ?? USER_ID)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "1h")
    .sign(options.key ?? signingKey);
}

let db: Db;
let chain: FakeChain;
let mcp: FakeMcp;
let dynamic: FakeDynamic;
let executor: ExecutorService;
let app: ReturnType<typeof createApp>["app"];
let clock: number;

function build(overrides: Partial<AppDeps> = {}) {
  db = testDb();
  chain = new FakeChain();
  mcp = new FakeMcp();
  dynamic = new FakeDynamic();
  clock = NOW;
  const created = createApp({
    db,
    logger: silentLogger,
    corsOrigin: "https://selio.site, http://localhost:5173",
    selioWebhookSecret: SELIO_SECRET,
    storageKey: STORAGE_KEY,
    chain,
    mcp,
    dynamic: {
      environmentId: ENVIRONMENT_ID,
      webhookSecret: DYNAMIC_SECRET,
      gateway: dynamic,
      verifyToken: createTokenVerifier(ENVIRONMENT_ID, keys),
    },
    review: { secret: REVIEW_SECRET, signingKey: reviewKeys.privateKey },
    agent: { cooldownMs: 300_000, maxGas: 3_000_000n, intentTtlMs: 120_000, maxGrantMs: 30 * DAY },
    now: () => clock,
    ...overrides,
  });
  app = created.app;
  executor = created.executor;
}

const hmac = (secret: string, body: string | Buffer) => createHmac("sha256", secret).update(body).digest("hex");

function grantBody(kind: "sell" | "bid" | "vault", overrides: Record<string, unknown> = {}) {
  const extra = kind === "sell" ? { maxSellDiscountBps: 300 } : kind === "bid" ? { minBidDiscountBps: 200, payIdx: 0 } : {};
  return {
    id: randomUUID(),
    network: "monad-testnet",
    kind,
    alertId: randomUUID(),
    thresholdBps: 9_000,
    maxPerAction: "100000000",
    maxTotal: "300000000",
    expiresAt: NOW + 7 * DAY,
    ...extra,
    ...overrides,
  };
}

async function createGrant(body: Record<string, unknown>, bearer?: string) {
  return request(app)
    .post("/agent/v1/grants")
    .set("Authorization", `Bearer ${bearer ?? (await token())}`)
    .send(body);
}

function alert(grantId: string, overrides: Record<string, unknown> = {}, secret = SELIO_SECRET) {
  const body = JSON.stringify({
    type: "selio.capacity.alert",
    network: "monad-testnet",
    utilizationBps: 9_950,
    thresholdBps: 9_000,
    withdrawable: "1000000",
    supplied: "500000000000",
    at: NOW - 1_000,
    ...overrides,
  });
  return request(app)
    .post(`/hooks/alert/${grantId}`)
    .set("Content-Type", "application/json")
    .set("X-Selio-Signature", `sha256=${hmac(secret, body)}`)
    .send(body);
}

const fieldsOf = (res: request.Response) => (res.body.details as { path: string }[]).map((d) => d.path);

describe("Dynamic JWT gate", () => {
  beforeEach(() => {
    build();
    seedDelegation(db);
  });

  it("answers 401 with WWW-Authenticate without a bearer token", async () => {
    const res = await request(app).get("/agent/v1/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("refuses a bad issuer, another key, an expired token, another environment and a token without user:basic", async () => {
    const bad = [
      await token({}, { issuer: "app.dynamicauth.com/another" }),
      await token({}, { key: otherKey }),
      await token({}, { exp: Math.floor(Date.now() / 1000) - 60 }),
      await token({ environment_id: "another-environment" }),
      await token({ scope: "user:mfa" }),
      await token({ scope: undefined }),
      "not-a-jwt",
    ];
    for (const bearer of bad) {
      const res = await request(app).get("/agent/v1/me").set("Authorization", `Bearer ${bearer}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    }
  });

  it("answers 403 when the token holds no EVM address", async () => {
    const bearer = await token({ verified_credentials: [{ email: "user@example.com", format: "email" }] });
    const res = await request(app).get("/agent/v1/me").set("Authorization", `Bearer ${bearer}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("answers 403 for a grant of an address the token does not hold", async () => {
    const other = seedGrant(db, { address: OTHER_WALLET });
    const res = await request(app)
      .delete(`/agent/v1/grants/${other.id}`)
      .set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(403);
    expect(new GrantRepository(db).find(other.id)?.status).toBe("active");
  });
});

describe("GET /agent/v1/me", () => {
  beforeEach(() => build());

  it("reports no delegation for a wallet that never delegated", async () => {
    const res = await request(app).get("/agent/v1/me").set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ address: WALLET_LC, delegation: null, grants: [], actions: [] });
  });

  it("returns the delegation, every grant newest first and the recent actions, marking expired grants", async () => {
    seedDelegation(db);
    const older = seedGrant(db, { kind: "vault", createdAt: NOW - 2_000, expiresAt: NOW - 1 });
    const newer = seedGrant(db, { kind: "bid", minBidDiscountBps: 100, payIdx: 0, createdAt: NOW - 1_000 });
    new ActionRepository(db).insert(
      { grantId: newer.id, kind: "bid", triggerAt: 5, utilizationBps: 9_950, status: "skipped", message: "Cooling down" },
      NOW,
    );
    const res = await request(app).get("/agent/v1/me").set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(res.body.delegation).toEqual({ status: "active", since: NOW - 60_000 });
    expect(res.body.grants.map((g: { id: string; status: string }) => [g.id, g.status])).toEqual([
      [newer.id, "active"],
      [older.id, "expired"],
    ]);
    expect(res.body.grants[0]).toMatchObject({ kind: "bid", maxPerAction: "100000000", usedTotal: "0", payIdx: 0, network: "monad-testnet" });
    expect(res.body.actions).toEqual([
      {
        id: 1,
        grantId: newer.id,
        kind: "bid",
        triggerAt: 5,
        utilizationBps: 9_950,
        assets: null,
        fee: null,
        net: null,
        status: "skipped",
        txHashes: [],
        bidId: null,
        message: "Cooling down",
        at: NOW,
      },
    ]);
  });
});

describe("POST /agent/v1/grants", () => {
  beforeEach(() => {
    build();
    seedDelegation(db);
  });

  it("creates sell, bid and vault grants; a sell grant defaults to every pay token", async () => {
    for (const kind of ["sell", "bid", "vault"] as const) {
      const body = grantBody(kind);
      const res = await createGrant(body);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: body.id });
    }
    const sell = new GrantRepository(db).listByAddress(WALLET_LC).find((g) => g.kind === "sell")!;
    expect(sell).toMatchObject({ payMask: 0b11, maxSellDiscountBps: 300, userId: USER_ID, status: "active", usedTotal: 0n });
  });

  it("validates the input of C.4", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [grantBody("sell", { payIdx: 0 }), ""],
      [grantBody("vault", { maxSellDiscountBps: 100 }), ""],
      [{ ...grantBody("vault"), kind: "swap" }, "kind"],
      [grantBody("vault", { maxTotal: "99999999" }), "maxTotal"],
      [grantBody("vault", { maxPerAction: "0" }), "maxPerAction"],
      [grantBody("vault", { maxPerAction: "1.5" }), "maxPerAction"],
      [grantBody("vault", { thresholdBps: 0 }), "thresholdBps"],
      [grantBody("vault", { thresholdBps: 10_001 }), "thresholdBps"],
      [grantBody("vault", { network: "usdt0-replay" }), "network"],
      [grantBody("vault", { id: "grant-1" }), "id"],
      [grantBody("vault", { alertId: "alert-1" }), "alertId"],
      [grantBody("vault", { expiresAt: NOW }), "expiresAt"],
      [grantBody("vault", { expiresAt: NOW + 30 * DAY + 1 }), "expiresAt"],
      [grantBody("sell", { maxSellDiscountBps: 5_001 }), "maxSellDiscountBps"],
      [grantBody("sell", { payMask: 4 }), "payMask"],
      [grantBody("sell", { payMask: 0 }), "payMask"],
      [grantBody("bid", { payIdx: 2 }), "payIdx"],
      [grantBody("bid", { minBidDiscountBps: -1 }), "minBidDiscountBps"],
    ];
    for (const [body, field] of cases) {
      const res = await createGrant(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      if (field) expect(fieldsOf(res)).toContain(field);
    }
    expect(new GrantRepository(db).listByAddress(WALLET_LC)).toHaveLength(0);
  });

  it("answers 409 without an active delegation, for a second active grant of a kind and for a reused id", async () => {
    const first = grantBody("vault");
    expect((await createGrant(first)).status).toBe(201);
    const again = await createGrant(grantBody("vault"));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("GRANT_EXISTS");
    const reused = await createGrant(grantBody("bid", { id: first.id }));
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("GRANT_ID_TAKEN");
    new DelegationRepository(db).end(WALLET_ID, "revoked", NOW, NOW);
    const revoked = await createGrant(grantBody("sell"));
    expect(revoked.status).toBe(409);
    expect(revoked.body.code).toBe("DELEGATION_REQUIRED");
  });

  it("lets a new grant of a kind replace an expired one", async () => {
    seedGrant(db, { kind: "vault", expiresAt: NOW - 1 });
    expect((await createGrant(grantBody("vault"))).status).toBe(201);
  });

  it("answers 403 when the delegation belongs to another Dynamic user", async () => {
    const res = await createGrant(grantBody("vault"), await token({}, { sub: OTHER_USER_ID }));
    expect(res.status).toBe(403);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await request(app)
      .post("/agent/v1/grants")
      .set("Authorization", `Bearer ${await token()}`)
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });
});

describe("DELETE /agent/v1/grants/:id", () => {
  beforeEach(() => {
    build();
    seedDelegation(db);
  });

  async function placedBid() {
    const grant = seedGrant(db, { kind: "bid", minBidDiscountBps: 200, payIdx: 0 });
    chain.setBalance(USDC, WALLET, 1_000_000_000n);
    chain.setAllowance(USDC, WALLET, MARKET, 1_000_000_000n);
    expect((await alert(grant.id, { thresholdBps: 9_000 })).status).toBe(202);
    await executor.idle();
    return grant;
  }

  it("revokes the grant and cancels its standing bid by default", async () => {
    const grant = await placedBid();
    const res = await request(app).delete(`/agent/v1/grants/${grant.id}`).set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(204);
    expect(new GrantRepository(db).find(grant.id)?.status).toBe("revoked");
    await executor.idle();
    expect(chain.sentCalls().map((c) => c.functionName)).toEqual(["placeBid", "cancelBid"]);
    const last = new ActionRepository(db).listForAddress(WALLET_LC, 1)[0];
    expect(last).toMatchObject({ kind: "cancel", status: "done", bidId: "42" });
  });

  it("keeps the bid with cancelBid=false", async () => {
    const grant = await placedBid();
    const res = await request(app)
      .delete(`/agent/v1/grants/${grant.id}?cancelBid=false`)
      .set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(204);
    await executor.idle();
    expect(chain.sentCalls().map((c) => c.functionName)).toEqual(["placeBid"]);
  });

  it("answers 404 for an unknown grant and 400 for a bad id or option", async () => {
    const bearer = `Bearer ${await token()}`;
    expect((await request(app).delete(`/agent/v1/grants/${randomUUID()}`).set("Authorization", bearer)).status).toBe(404);
    expect((await request(app).delete("/agent/v1/grants/abc").set("Authorization", bearer)).status).toBe(400);
    const grant = seedGrant(db);
    expect((await request(app).delete(`/agent/v1/grants/${grant.id}?cancelBid=maybe`).set("Authorization", bearer)).status).toBe(400);
  });
});

describe("POST /agent/v1/revoke", () => {
  beforeEach(() => {
    build();
    seedDelegation(db);
  });

  it("revokes at once: materials deleted, every grant revoked, Dynamic's admin revoke called", async () => {
    const vault = seedGrant(db, { kind: "vault" });
    const sell = seedGrant(db, { kind: "sell", maxSellDiscountBps: 100, payMask: 1 });
    const res = await request(app).post("/agent/v1/revoke").set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true, dynamicRevoked: true });
    expect(new DelegationRepository(db).find(WALLET_ID)).toMatchObject({ status: "revoked", sealedShare: null, sealedApiKey: null });
    expect(new GrantRepository(db).find(vault.id)?.status).toBe("revoked");
    expect(new GrantRepository(db).find(sell.id)?.status).toBe("revoked");
    expect(dynamic.revoked).toEqual([WALLET_ID]);
    const next = await alert(vault.id);
    expect(next.status).toBe(410);
    expect(next.body.code).toBe("GRANT_INACTIVE");
  });

  it("reports dynamicRevoked false when Dynamic's admin call fails", async () => {
    dynamic.revokeResult = false;
    const res = await request(app).post("/agent/v1/revoke").set("Authorization", `Bearer ${await token()}`);
    expect(res.body).toEqual({ revoked: true, dynamicRevoked: false });
  });

  it("answers 403 to another Dynamic user holding the address", async () => {
    const res = await request(app).post("/agent/v1/revoke").set("Authorization", `Bearer ${await token({}, { sub: OTHER_USER_ID })}`);
    expect(res.status).toBe(403);
    expect(new DelegationRepository(db).find(WALLET_ID)?.status).toBe("active");
  });
});

describe("POST /hooks/alert/:grantId", () => {
  beforeEach(() => {
    build();
    seedDelegation(db);
    chain.setBalance(USDC, WALLET, 500_000_000n);
    chain.setAllowance(USDC, WALLET, VAULT, 500_000_000n);
  });

  it("queues an action that re-checks the chain and acts, then treats the same event as a duplicate", async () => {
    const grant = seedGrant(db, { kind: "vault" });
    const res = await alert(grant.id);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    await executor.idle();
    expect(chain.sentCalls()).toHaveLength(1);
    expect(new GrantRepository(db).find(grant.id)?.usedTotal).toBe(100_000_000n);
    const again = await alert(grant.id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ duplicate: true });
  });

  it("records a cooling-down skip for an event within the cooldown, and acts after it", async () => {
    const grant = seedGrant(db, { kind: "vault" });
    await alert(grant.id, { at: NOW - 3_000 });
    await executor.idle();
    clock = NOW + 60_000;
    const cooling = await alert(grant.id, { at: NOW + 50_000 });
    expect(cooling.status).toBe(202);
    expect(cooling.body).toEqual({ queued: false });
    clock = NOW + 400_000;
    expect((await alert(grant.id, { at: NOW + 390_000 })).body).toEqual({ queued: true });
    await executor.idle();
    const statuses = new ActionRepository(db).listForAddress(WALLET_LC, 10).map((a) => [a.status, a.message]);
    expect(statuses).toEqual([
      ["done", null],
      ["skipped", "Cooling down"],
      ["done", null],
    ]);
  });

  it("answers 401 to a wrong signature and to a body re-serialized with other whitespace", async () => {
    const grant = seedGrant(db, { kind: "vault" });
    expect((await alert(grant.id, {}, "another-secret")).status).toBe(401);
    const body = JSON.stringify({ type: "selio.capacity.alert", network: "monad-testnet", utilizationBps: 9_950, thresholdBps: 9_000, withdrawable: "1", supplied: "2", at: 1 });
    const res = await request(app)
      .post(`/hooks/alert/${grant.id}`)
      .set("Content-Type", "application/json")
      .set("X-Selio-Signature", `sha256=${hmac(SELIO_SECRET, body)}`)
      .send(JSON.stringify(JSON.parse(body), null, 2));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("BAD_SIGNATURE");
    const text = await request(app)
      .post(`/hooks/alert/${grant.id}`)
      .set("Content-Type", "text/plain")
      .set("X-Selio-Signature", `sha256=${hmac(SELIO_SECRET, body)}`)
      .send(body);
    expect(text.status).toBe(401);
  });

  it("answers 404, 410 and 422 without running anything", async () => {
    expect((await alert(randomUUID())).status).toBe(404);
    const revoked = seedGrant(db, { kind: "vault", status: "revoked" });
    expect((await alert(revoked.id)).status).toBe(410);
    const expired = seedGrant(db, { kind: "bid", minBidDiscountBps: 100, payIdx: 0, expiresAt: NOW });
    expect((await alert(expired.id)).status).toBe(410);
    expect(new GrantRepository(db).find(expired.id)?.status).toBe("expired");
    const grant = seedGrant(db, { kind: "sell", maxSellDiscountBps: 100, payMask: 1 });
    for (const mismatch of [{ type: "other" }, { network: "usdt0-replay" }, { thresholdBps: 8_000 }]) {
      const res = await alert(grant.id, mismatch);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("TRIGGER_MISMATCH");
    }
    expect(new ActionRepository(db).listForAddress(WALLET_LC, 10)).toHaveLength(0);
  });
});

describe("POST /dynamic/webhooks", () => {
  beforeEach(() => build());

  const event = {
    eventId: "evt-1",
    eventName: "wallet.delegation.created",
    timestamp: new Date(NOW - 1_000).toISOString(),
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    data: {
      chain: "EVM",
      walletId: WALLET_ID,
      userId: USER_ID,
      publicKey: WALLET,
      encryptedDelegatedShare: envelopeOf(JSON.stringify(KEY_SHARE)),
      encryptedWalletApiKey: envelopeOf(WALLET_API_KEY),
    },
  };

  function post(body: string, signature = `sha256=${hmac(DYNAMIC_SECRET, body)}`) {
    return request(app)
      .post("/dynamic/webhooks")
      .set("Content-Type", "application/json")
      .set("x-dynamic-signature-256", signature)
      .send(body);
  }

  it("stores the delegation from the raw signed body and acknowledges redeliveries", async () => {
    const body = JSON.stringify(event);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(new DelegationRepository(db).find(WALLET_ID)?.status).toBe("active");
    expect((await post(body)).status).toBe(200);
  });

  it("answers 401 to a bad signature or a re-serialized body", async () => {
    const body = JSON.stringify(event);
    expect((await post(body, "sha256=00")).status).toBe(401);
    expect((await post(JSON.stringify(event, null, 2), `sha256=${hmac(DYNAMIC_SECRET, body)}`)).status).toBe(401);
    expect(new DelegationRepository(db).find(WALLET_ID)).toBeNull();
  });
});

describe("POST /dynamic/transaction-review", () => {
  beforeEach(() => build());

  function review(value: unknown, signature?: string) {
    const body = JSON.stringify(value);
    return request(app)
      .post("/dynamic/transaction-review")
      .set("Content-Type", "application/json")
      .set("x-dynamic-signature", signature ?? hmac(REVIEW_SECRET, body))
      .send(body);
  }

  it("answers 401 with the fixed denial to an unsigned request", async () => {
    const res = await review({ shareSetType: "rootUser", context: { evmMessage: "hi" } }, "00");
    expect(res.status).toBe(401);
    expect(res.text).toBe('{"proceed":false,"reason":"Invalid signature"}');
  });

  it("signs its answers with the response key", async () => {
    const res = await review({ shareSetType: "rootUser", walletId: WALLET_ID, context: { evmMessage: "Sign in to Selio" } });
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"proceed":true}');
    const signature = Buffer.from(String(res.headers["x-dynamic-response-signature"]), "base64");
    expect(verify(null, Buffer.from(res.text), reviewKeys.publicKey, signature)).toBe(true);
  });

  it("denies a delegated transaction without an intent and the user's transactions off Monad testnet", async () => {
    seedDelegation(db);
    const delegated = await review({
      shareSetType: "delegated",
      walletId: WALLET_ID,
      context: { evmTransaction: { to: VAULT, data: "0xbc157ac1", chainId: 10143, nonce: 1 } },
    });
    expect(delegated.body).toEqual({ proceed: false, reason: "No matching agent intent" });
    const fork = await review({ shareSetType: "rootUser", context: { evmTransaction: { to: MARKET, chainId: 143 } } });
    expect(fork.body).toEqual({ proceed: false, reason: "Selio wallets sign only on Monad testnet" });
  });
});

describe("not configured state", () => {
  beforeEach(() => build({ dynamic: null }));

  it("reports Dynamic as not configured on readyz and on the agent routes; health and reviews still answer", async () => {
    expect((await request(app).get("/healthz")).body).toEqual({ status: "ok" });
    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({
      code: "NOT_READY",
      message: "Dynamic is not configured: set DYNAMIC_ENVIRONMENT_ID, DYNAMIC_API_TOKEN, DYNAMIC_WEBHOOK_SECRET",
    });
    const me = await request(app).get("/agent/v1/me").set("Authorization", `Bearer ${await token()}`);
    expect(me.status).toBe(503);
    expect(me.body.code).toBe("DYNAMIC_NOT_CONFIGURED");
    const hook = await request(app).post("/dynamic/webhooks").set("Content-Type", "application/json").send("{}");
    expect(hook.status).toBe(503);
    const body = JSON.stringify({ shareSetType: "rootUser", context: { evmMessage: "x" } });
    const reviewed = await request(app)
      .post("/dynamic/transaction-review")
      .set("Content-Type", "application/json")
      .set("x-dynamic-signature", hmac(REVIEW_SECRET, body))
      .send(body);
    expect(reviewed.body).toEqual({ proceed: true });
  });

  it("is ready once Dynamic is configured", async () => {
    build();
    expect((await request(app).get("/readyz")).body).toEqual({ status: "ready" });
  });
});

describe("HTTP behaviour", () => {
  beforeEach(() => build({ requestLimits: { windowMs: 60_000, api: 2 } }));

  it("answers CORS preflights for the web origin", async () => {
    const res = await request(app)
      .options("/agent/v1/grants")
      .set("Origin", "https://selio.site")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://selio.site");
    expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
    const other = await request(app).get("/healthz").set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("limits /agent/v1/* per IP and leaves the other routes alone", async () => {
    const bearer = `Bearer ${await token()}`;
    expect((await request(app).get("/agent/v1/me").set("Authorization", bearer)).status).toBe(200);
    expect((await request(app).get("/agent/v1/me").set("Authorization", bearer)).status).toBe(200);
    const limited = await request(app).get("/agent/v1/me").set("Authorization", bearer);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBe("60");
    expect((await request(app).get("/healthz")).status).toBe(200);
  });

  it("answers 404 with the envelope for an unknown route", async () => {
    const res = await request(app).get("/nope?x=1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "NOT_FOUND", message: "No route for GET /nope" });
  });
});
