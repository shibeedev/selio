import { createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { open } from "../../shared/crypto/seal.js";
import { createTransactional, type Db } from "../../shared/db/database.js";
import { AppError } from "../../shared/errors/AppError.js";
import { parseKeyShare } from "../../shared/integrations/dynamic/dynamic.gateway.js";
import {
  DYNAMIC_SECRET,
  ENVIRONMENT_ID,
  FakeDynamic,
  KEY_SHARE,
  NOW,
  STORAGE_KEY,
  USER_ID,
  WALLET,
  WALLET_API_KEY,
  WALLET_ID,
  WALLET_LC,
  envelopeOf,
  seedGrant,
  silentLogger,
  testDb,
} from "../../testing/fakes.js";
import { GrantRepository } from "../grants/index.js";
import { DelegationRepository } from "./delegations.repository.js";
import { DelegationService } from "./delegations.service.js";

let db: Db;
let repo: DelegationRepository;
let grants: GrantRepository;
let dynamic: FakeDynamic;
let service: DelegationService;
let decrypts = 0;

const iso = (ms: number) => new Date(ms).toISOString();

function created(eventId: string, at: number) {
  return {
    messageId: `m-${eventId}`,
    eventId,
    eventName: "wallet.delegation.created",
    timestamp: iso(at),
    webhookId: "wh-1",
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    environmentName: "sandbox",
    data: {
      chain: "EVM",
      walletId: WALLET_ID,
      userId: USER_ID,
      publicKey: WALLET,
      shareSetId: "share-set-1",
      encryptedDelegatedShare: envelopeOf(JSON.stringify(KEY_SHARE)),
      encryptedWalletApiKey: envelopeOf(WALLET_API_KEY),
    },
  };
}

function revoked(eventId: string, at: number) {
  return {
    messageId: `m-${eventId}`,
    eventId,
    eventName: "wallet.delegation.revoked",
    timestamp: iso(at),
    webhookId: "wh-1",
    userId: USER_ID,
    environmentId: ENVIRONMENT_ID,
    data: { chain: "EVM", walletId: WALLET_ID, publicKey: WALLET },
  };
}

function deliver(event: unknown, secret = DYNAMIC_SECRET) {
  const body = Buffer.from(JSON.stringify(event));
  service.handleWebhook(body, `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
}

beforeEach(() => {
  db = testDb();
  repo = new DelegationRepository(db);
  grants = new GrantRepository(db);
  dynamic = new FakeDynamic();
  decrypts = 0;
  const counting = {
    decryptDelegation: (input: Parameters<FakeDynamic["decryptDelegation"]>[0]) => {
      decrypts++;
      return dynamic.decryptDelegation(input);
    },
  };
  service = new DelegationService(
    repo,
    grants,
    counting,
    createTransactional(db),
    silentLogger,
    { storageKey: STORAGE_KEY, webhook: { environmentId: ENVIRONMENT_ID, secret: DYNAMIC_SECRET } },
    () => NOW,
  );
});

describe("wallet.delegation.created", () => {
  it("stores an active delegation whose materials open only with the storage key", () => {
    deliver(created("evt-1", NOW - 1_000));
    const row = repo.find(WALLET_ID)!;
    expect(row).toMatchObject({ walletId: WALLET_ID, userId: USER_ID, address: WALLET_LC, shareSetId: "share-set-1", status: "active" });
    expect(row.eventAt).toBe(NOW - 1_000);
    const stored = JSON.stringify(db.prepare("SELECT * FROM delegations").all());
    expect(stored).not.toContain("test-secret-share-material");
    expect(stored).not.toContain(WALLET_API_KEY);
    expect(parseKeyShare(open(row.sealedShare!, STORAGE_KEY, WALLET_ID))).toEqual(KEY_SHARE);
    expect(open(row.sealedApiKey!, STORAGE_KEY, WALLET_ID)).toBe(WALLET_API_KEY);
    expect(() => open(row.sealedShare!, randomBytes(32), WALLET_ID)).toThrow();
  });

  it("handles a duplicate event id once", () => {
    deliver(created("evt-1", NOW - 1_000));
    deliver(created("evt-1", NOW - 1_000));
    expect(decrypts).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()!.n).toBe(1);
  });

  it("ignores a non-EVM delegation and an event of another environment", () => {
    deliver({ ...created("evt-1", NOW - 1_000), data: { ...created("evt-1", 0).data, chain: "SOL" } });
    deliver({ ...created("evt-2", NOW - 1_000), environmentId: "another-environment" });
    expect(repo.find(WALLET_ID)).toBeNull();
    expect(decrypts).toBe(0);
  });

  it("does not record an event it could not decrypt, so a redelivery is processed", () => {
    const broken = new DelegationService(
      repo,
      grants,
      {
        decryptDelegation: () => {
          throw new AppError(502, "UPSTREAM_ERROR", "The delegation could not be decrypted with the agent's key");
        },
      },
      createTransactional(db),
      silentLogger,
      { storageKey: STORAGE_KEY, webhook: { environmentId: ENVIRONMENT_ID, secret: DYNAMIC_SECRET } },
      () => NOW,
    );
    const body = Buffer.from(JSON.stringify(created("evt-1", NOW - 1_000)));
    broken.handleWebhook(body, `sha256=${createHmac("sha256", DYNAMIC_SECRET).update(body).digest("hex")}`);
    expect(repo.find(WALLET_ID)).toBeNull();
    deliver(created("evt-1", NOW - 1_000));
    expect(repo.find(WALLET_ID)?.status).toBe("active");
  });
});

describe("wallet.delegation.revoked", () => {
  it("revokes the delegation, deletes its materials and revokes every grant of the address", () => {
    deliver(created("evt-1", NOW - 2_000));
    const sell = seedGrant(db, { kind: "sell", maxSellDiscountBps: 100, payMask: 1 });
    const used = seedGrant(db, { kind: "vault", status: "exhausted" });
    const other = seedGrant(db, { kind: "vault", address: "0x00000000000000000000000000000000000000bb" });
    deliver(revoked("evt-2", NOW - 1_000));
    const row = repo.find(WALLET_ID)!;
    expect(row).toMatchObject({ status: "revoked", sealedShare: null, sealedApiKey: null, eventAt: NOW - 1_000 });
    expect(grants.find(sell.id)?.status).toBe("revoked");
    expect(grants.find(used.id)?.status).toBe("revoked");
    expect(grants.find(other.id)?.status).toBe("active");
  });

  it("keeps a revocation that arrives before its older created event", () => {
    deliver(revoked("evt-2", NOW - 1_000));
    expect(repo.find(WALLET_ID)).toMatchObject({ status: "revoked", sealedShare: null });
    deliver(created("evt-1", NOW - 2_000));
    expect(repo.find(WALLET_ID)).toMatchObject({ status: "revoked", sealedShare: null, sealedApiKey: null });
  });

  it("ignores a redelivered created event after the revocation", () => {
    deliver(created("evt-1", NOW - 2_000));
    deliver(revoked("evt-2", NOW - 1_000));
    deliver(created("evt-1", NOW - 2_000));
    expect(repo.find(WALLET_ID)?.status).toBe("revoked");
  });

  it("lets a new delegation activate again while the old grants stay revoked", () => {
    deliver(created("evt-1", NOW - 3_000));
    const grant = seedGrant(db, { kind: "bid", minBidDiscountBps: 100, payIdx: 0 });
    deliver(revoked("evt-2", NOW - 2_000));
    deliver(created("evt-3", NOW - 1_000));
    expect(repo.find(WALLET_ID)).toMatchObject({ status: "active", eventAt: NOW - 1_000 });
    expect(repo.find(WALLET_ID)?.sealedShare).not.toBeNull();
    expect(grants.find(grant.id)?.status).toBe("revoked");
  });
});

describe("webhook authentication and other events", () => {
  it("rejects a wrong signature and changes nothing", () => {
    expect(() => deliver(created("evt-1", NOW), "another-secret")).toThrow(
      expect.objectContaining({ statusCode: 401, code: "BAD_SIGNATURE" }),
    );
    expect(repo.find(WALLET_ID)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_events").get()!.n).toBe(0);
  });

  it("acknowledges ping and unknown events", () => {
    deliver({ eventId: "evt-ping", eventName: "ping", timestamp: iso(NOW), environmentId: ENVIRONMENT_ID, data: {} });
    deliver({ eventId: "evt-sig", eventName: "wallet.delegation.signature", timestamp: iso(NOW), environmentId: ENVIRONMENT_ID, data: {} });
    expect(db.prepare("SELECT event_name FROM webhook_events ORDER BY event_name").all().map((r) => r.event_name)).toEqual([
      "ping",
      "wallet.delegation.signature",
    ]);
  });

  it("answers 503 while Dynamic is not configured", () => {
    const unconfigured = new DelegationService(repo, grants, null, createTransactional(db), silentLogger, {
      storageKey: STORAGE_KEY,
      webhook: null,
    });
    expect(() => unconfigured.handleWebhook(Buffer.from("{}"), undefined)).toThrow(
      expect.objectContaining({ statusCode: 503, code: "DYNAMIC_NOT_CONFIGURED" }),
    );
  });
});

describe("end", () => {
  it("marks an active delegation invalid and revokes its grants, but never revives a revoked one", () => {
    deliver(created("evt-1", NOW - 2_000));
    const grant = seedGrant(db);
    expect(service.end(WALLET_ID, "invalid")).toMatchObject({ status: "invalid", sealedShare: null, sealedApiKey: null });
    expect(grants.find(grant.id)?.status).toBe("revoked");
    expect(service.end(WALLET_ID, "revoked")?.status).toBe("revoked");
    expect(service.end(WALLET_ID, "invalid")?.status).toBe("revoked");
  });
});
