import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChainLayer } from "@selio/mcp";
import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { WebhookPayload } from "./modules/alerts/index.js";
import type { Db } from "./shared/db/database.js";
import {
  emptyMcpChain,
  fakeChain,
  OTHER_SIGNER,
  OWNER,
  signIn,
  SIGNER,
  silentLogger,
  testDb,
  USDT0_REPLAY_DEPLOYMENT,
} from "./testing/fakes.js";

const HOUR = 3_600_000;
const MCP_HEADERS = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };

let db: Db;
let clock: number;
let chain: ReturnType<typeof fakeChain>;
let webhook: { deliver: ReturnType<typeof vi.fn>; checkTarget: ReturnType<typeof vi.fn> };
let kits: { runKit: ReturnType<typeof vi.fn> };
let rpcUpstream: { send: ReturnType<typeof vi.fn> };
let app: Express;
let poll: () => Promise<void>;

beforeEach(() => {
  db = testDb();
  clock = 100 * HOUR;
  chain = fakeChain();
  webhook = {
    deliver: vi.fn(async (_url: string, _payload: WebhookPayload) => undefined),
    checkTarget: vi.fn(async (url: string) => ({ url, address: "203.0.113.10", family: 4 as const })),
  };
  kits = { runKit: vi.fn(async (_network: string, _kit: string, address: string) => [`Funded ${address} with 10 MON for gas`]) };
  rpcUpstream = { send: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: "0x8f" })) };
  const built = createApp({
    db,
    logger: silentLogger,
    chain,
    mcpChain: emptyMcpChain,
    corsOrigin: "*",
    webhook,
    kits,
    rpcUpstream,
    now: () => clock,
  });
  app = built.app;
  poll = async () => {
    await built.alerts.service.evaluateSnapshots(await built.capacity.service.snapshotAll());
  };
});

afterEach(() => {
  if (db.isOpen) db.close();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const signer = SIGNER.address.toLowerCase();
const otherSigner = OTHER_SIGNER.address.toLowerCase();

describe("health", () => {
  it("reports liveness and DB readiness", async () => {
    expect((await request(app).get("/healthz").expect(200)).body).toEqual({ status: "ok" });
    expect((await request(app).get("/readyz").expect(200)).body).toEqual({ status: "ready" });
    db.close();
    const notReady = await request(app).get("/readyz").expect(503);
    expect(notReady.text).toBe('{"code":"NOT_READY","message":"Database unavailable"}');
    await request(app).get("/healthz").expect(200);
  });
});

describe("cross-cutting HTTP behaviour", () => {
  it("echoes or creates a request id and answers CORS preflights", async () => {
    const echoed = await request(app).get("/healthz").set("x-request-id", "abc-123").expect(200);
    expect(echoed.headers["x-request-id"]).toBe("abc-123");
    expect(echoed.headers["access-control-allow-origin"]).toBe("*");
    expect(echoed.headers["x-powered-by"]).toBeUndefined();
    const generated = await request(app).get("/healthz").set("x-request-id", "has space").expect(200);
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const preflight = await request(app).options("/api/alerts").set("Origin", "http://localhost:5173").expect(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(preflight.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(preflight.headers["access-control-expose-headers"]).toContain("Retry-After");
  });

  it("formats unknown routes and bad JSON as { code, message }", async () => {
    const missing = await request(app).get("/api/nope").expect(404);
    expect(missing.body).toEqual({ code: "NOT_FOUND", message: "No route for GET /api/nope" });
    const bad = await request(app).post("/api/faucet").set("Content-Type", "application/json").send("{oops").expect(400);
    expect(bad.body).toEqual({ code: "INVALID_JSON", message: "Request body is not valid JSON" });
  });
});

describe("GET /api/networks", () => {
  it("lists every network with deployment and RPC status", async () => {
    const { networks } = (await request(app).get("/api/networks").expect(200)).body as {
      networks: Record<string, unknown>[];
    };
    expect(networks.map((n) => n.key)).toEqual(["monad-testnet", "usdt0-replay", "vault-freeze"]);
    expect(networks[1]).toMatchObject({
      key: "usdt0-replay",
      label: "USDT0 replay",
      venue: "aave",
      isFork: true,
      chainId: 143,
      explorerUrl: null,
      deploymentLoaded: true,
      market: "0x0000000000000000000000000000000000001001",
      rpcReachable: true,
    });
    expect(networks[0]).toMatchObject({
      key: "monad-testnet",
      label: "Monad Testnet",
      chainId: 10143,
      explorerUrl: "https://testnet.monadscan.com",
      deploymentLoaded: false,
      market: null,
      rpcReachable: false,
    });
  });
});

describe("capacity", () => {
  it("serves live capacity with amounts as strings", async () => {
    const body = (await request(app).get("/api/capacity/usdt0-replay").expect(200)).body;
    expect(body).toMatchObject({
      network: "usdt0-replay",
      at: clock,
      underlying: { symbol: "USDT0", decimals: 6 },
      withdrawable: "100000000000000000",
      supplied: "1000000000000000000000",
      utilizationBps: 9999,
      sessionAssets: "0",
    });
    expect(body.bidCapacity).toEqual(
      [100, 300, 500, 1000, 2000].map((d) => ({ discountBps: d, assets: (BigInt(d) * 10n ** 18n).toString() })),
    );
  });

  it("validates the network and reports missing deployments", async () => {
    const invalid = await request(app).get("/api/capacity/mainnet").expect(400);
    expect(invalid.body).toEqual({
      code: "VALIDATION_ERROR",
      message: "Invalid request",
      details: [
        {
          path: "network",
          message: "Invalid enum value. Expected 'monad-testnet' | 'usdt0-replay' | 'vault-freeze', received 'mainnet'",
        },
      ],
    });
    const missing = await request(app).get("/api/capacity/monad-testnet").expect(404);
    expect(missing.body).toEqual({ code: "DEPLOYMENT_NOT_FOUND", message: "No Selio deployment for monad-testnet" });
  });

  it("returns the polled history inside the window", async () => {
    clock = 90 * HOUR;
    await poll();
    clock = 99 * HOUR;
    chain.state.utilizationBps = 9_000;
    await poll();
    clock = 100 * HOUR;

    const recent = (await request(app).get("/api/capacity/usdt0-replay/history?hours=2").expect(200)).body;
    expect(recent).toEqual({
      points: [{ t: 99 * HOUR, utilizationBps: 9000, withdrawable: "100000000000000000", supplied: "1000000000000000000000" }],
    });
    const all = (await request(app).get("/api/capacity/usdt0-replay/history").expect(200)).body.points;
    expect(all.map((p: { t: number }) => p.t)).toEqual([90 * HOUR, 99 * HOUR]);
    await request(app).get("/api/capacity/usdt0-replay/history?hours=0").expect(400);
    await request(app).get("/api/capacity/usdt0-replay/history?hours=1000").expect(400);
  });
});

describe("auth", () => {
  it("signs in over HTTP and gates the alert routes", async () => {
    const nonce = await request(app).post("/api/auth/nonce").send({ address: SIGNER.address }).expect(200);
    expect(nonce.body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(nonce.body.expiresAt).toBeGreaterThan(clock);

    const token = await signIn(app, SIGNER);
    const anonymous = await request(app).get(`/api/alerts?owner=${signer}`).expect(401);
    expect(anonymous.body).toEqual({ code: "UNAUTHORIZED", message: "Sign in with your wallet to manage alerts" });
    expect(anonymous.headers["www-authenticate"]).toBe("Bearer");
    const unknown = await request(app).get(`/api/alerts?owner=${signer}`).set(auth("made-up-token")).expect(401);
    expect(unknown.body.message).toBe("Your sign-in has expired or is not valid; sign in again");
    const foreign = await request(app).get(`/api/alerts?owner=${otherSigner}`).set(auth(token)).expect(403);
    expect(foreign.body).toEqual({ code: "FORBIDDEN", message: `Signed in as ${signer}, not ${otherSigner}` });
    await request(app).post("/api/alerts").send({ network: "usdt0-replay", thresholdBps: 9000, owner: signer }).expect(401);

    const { id } = (
      await request(app)
        .post("/api/alerts")
        .set(auth(token))
        .send({ network: "usdt0-replay", thresholdBps: 9000, owner: signer })
        .expect(201)
    ).body;
    expect((await request(app).get(`/api/alerts?owner=${signer}`).set(auth(token)).expect(200)).body.alerts).toHaveLength(1);
    expect((await request(app).get(`/api/alerts/events?owner=${signer}`).set(auth(token)).expect(200)).body).toEqual({
      events: [],
    });
    await request(app).delete(`/api/alerts/${id}?owner=${signer}`).set(auth(token)).expect(204);

    const badSignature = await request(app)
      .post("/api/auth/verify")
      .send({ message: "x", signature: "0x1234" })
      .expect(400);
    expect(badSignature.body.details).toEqual([{ path: "signature", message: "must be a 65-byte 0x-prefixed hex signature" }]);
  });
});

describe("alerts", () => {
  it("creates, lists and deletes alerts for their owner", async () => {
    const token = await signIn(app, SIGNER);
    const otherToken = await signIn(app, OTHER_SIGNER);
    const created = await request(app)
      .post("/api/alerts")
      .set(auth(token))
      .send({ network: "usdt0-replay", thresholdBps: 9500, owner: SIGNER.address })
      .expect(201);
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.headers.location).toBeUndefined();

    const list = (await request(app).get(`/api/alerts?owner=${SIGNER.address}`).set(auth(token)).expect(200)).body;
    expect(list).toEqual({
      alerts: [{ id: created.body.id, owner: signer, network: "usdt0-replay", thresholdBps: 9500, webhook: null, createdAt: clock }],
    });

    const notYours = await request(app)
      .delete(`/api/alerts/${created.body.id}?owner=${otherSigner}`)
      .set(auth(otherToken))
      .expect(403);
    expect(notYours.body).toEqual({ code: "FORBIDDEN", message: "Alert belongs to another owner" });
    await request(app).delete(`/api/alerts/${created.body.id}`).set(auth(token)).send({ owner: signer }).expect(204);
    const again = await request(app).delete(`/api/alerts/${created.body.id}`).set(auth(token)).send({ owner: signer }).expect(404);
    expect(again.body).toEqual({ code: "ALERT_NOT_FOUND", message: `Alert ${created.body.id} not found` });
    expect((await request(app).get(`/api/alerts?owner=${signer}`).set(auth(token)).expect(200)).body).toEqual({ alerts: [] });
  });

  it("validates threshold, owner and webhook URL", async () => {
    const token = await signIn(app, SIGNER);
    const create = (body: Record<string, unknown>) =>
      request(app)
        .post("/api/alerts")
        .set(auth(token))
        .send({ network: "usdt0-replay", thresholdBps: 9000, owner: signer, ...body });
    await create({ thresholdBps: 0 }).expect(400);
    await create({ thresholdBps: 10_001 }).expect(400);
    await create({ owner: "0x123" }).expect(400);
    for (const webhookUrl of ["http://example.com/hook", "ftp://example.com", "http://127.0.0.1:9999/hook"]) {
      const refused = await create({ webhookUrl }).expect(400);
      expect(refused.body.details).toEqual([
        { path: "webhookUrl", message: "webhookUrl must be https, or http://localhost in development" },
      ]);
    }
    await create({ webhookUrl: "https://hooks.example.com/x" }).expect(201);
    await create({ webhookUrl: "http://localhost:9999/hook" }).expect(201);
    expect(webhook.checkTarget).toHaveBeenCalledTimes(2);
    const noOwner = await request(app).get("/api/alerts").set(auth(token)).expect(400);
    expect(noOwner.body.details).toEqual([{ path: "owner", message: "Required" }]);
  });

  it("masks webhook URLs in listings", async () => {
    const token = await signIn(app, SIGNER);
    await request(app)
      .post("/api/alerts")
      .set(auth(token))
      .send({ network: "usdt0-replay", thresholdBps: 9000, owner: signer, webhookUrl: "https://hooks.example.com/x/abcd" })
      .expect(201);
    const res = await request(app).get(`/api/alerts?owner=${signer}`).set(auth(token)).expect(200);
    expect(res.body.alerts[0].webhook).toEqual({ host: "hooks.example.com", last4: "abcd" });
    expect(res.text).not.toContain("/x/");
    expect(res.body.alerts[0]).not.toHaveProperty("webhookUrl");
  });

  it("records in-app events and posts webhooks when a poll crosses the threshold", async () => {
    const token = await signIn(app, SIGNER);
    const { id } = (
      await request(app)
        .post("/api/alerts")
        .set(auth(token))
        .send({ network: "usdt0-replay", thresholdBps: 9500, owner: signer, webhookUrl: "https://hooks.example.com/x" })
        .expect(201)
    ).body;
    chain.state.utilizationBps = 9_000;
    await poll();
    clock += 60_000;
    chain.state.utilizationBps = 9_700;
    await poll();
    clock += 60_000;
    await poll();

    const { events } = (await request(app).get(`/api/alerts/events?owner=${signer}`).set(auth(token)).expect(200)).body;
    expect(events).toEqual([
      { id: 1, alertId: id, network: "usdt0-replay", utilizationBps: 9700, thresholdBps: 9500, at: 100 * HOUR + 60_000 },
    ]);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    expect(webhook.deliver.mock.calls[0]?.[1]).toMatchObject({
      type: "selio.capacity.alert",
      utilizationBps: 9700,
      supplied: "1000000000000000000000",
    });

    const otherToken = await signIn(app, OTHER_SIGNER);
    expect(
      (await request(app).get(`/api/alerts/events?owner=${otherSigner}`).set(auth(otherToken)).expect(200)).body,
    ).toEqual({ events: [] });
  });
});

describe("POST /api/faucet", () => {
  it("serves fork networks only, once per kit per window", async () => {
    const live = await request(app).post("/api/faucet").send({ network: "monad-testnet", address: OWNER, kit: "seller" }).expect(403);
    expect(live.body).toEqual({
      code: "FAUCET_FORK_ONLY",
      message: "The faucet only works on fork networks; monad-testnet is a live network",
    });

    const sent = await request(app).post("/api/faucet").send({ network: "usdt0-replay", address: OWNER, kit: "seller" }).expect(200);
    expect(sent.body).toEqual({ ok: true, actions: [`Funded ${OWNER} with 10 MON for gas`] });
    expect(kits.runKit).toHaveBeenCalledWith("usdt0-replay", "seller", OWNER);

    const repeat = await request(app).post("/api/faucet").send({ network: "usdt0-replay", address: OWNER, kit: "seller" }).expect(429);
    expect(repeat.body).toEqual({
      code: "FAUCET_RATE_LIMITED",
      message: "A seller kit was already sent to this address on usdt0-replay; try again in 600s",
      details: { retryAfterSeconds: 600 },
    });
    await request(app).post("/api/faucet").send({ network: "usdt0-replay", address: OWNER, kit: "bidder" }).expect(200);
    clock += 10 * 60_000;
    await request(app).post("/api/faucet").send({ network: "usdt0-replay", address: OWNER, kit: "seller" }).expect(200);
  });

  it("validates the kit and address", async () => {
    await request(app).post("/api/faucet").send({ network: "usdt0-replay", address: OWNER, kit: "whale" }).expect(400);
    await request(app).post("/api/faucet").send({ network: "usdt0-replay", address: "nope", kit: "seller" }).expect(400);
    expect(kits.runKit).not.toHaveBeenCalled();
  });
});

describe("MCP over Streamable HTTP", () => {
  it("initializes and lists tools statelessly", async () => {
    const init = await request(app)
      .post("/mcp")
      .set(MCP_HEADERS)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "backend-test", version: "0" } },
      })
      .expect(200);
    expect(init.body.result.serverInfo.name).toBe("selio");
    expect(init.headers["mcp-session-id"]).toBeUndefined();

    const list = await request(app).post("/mcp").set(MCP_HEADERS).send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }).expect(200);
    const names = (list.body.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("build_buy_and_repay");
    expect(names).toContain("simulate_transaction");
  });

  it("bounds the chain reads of one request with mcpMaxReadsPerRequest", async () => {
    // A fork node stand-in that answers every eth_call with zero words and counts requests per URL path.
    const received: Record<string, number> = {};
    const node = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received[req.url ?? ""] = (received[req.url ?? ""] ?? 0) + 1;
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${"00".repeat(160)}` }));
      });
    });
    await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
    const dir = mkdtempSync(join(tmpdir(), "selio-mcp-"));
    mkdirSync(join(dir, "local"));
    writeFileSync(join(dir, "local", "usdt0-replay.json"), JSON.stringify(USDT0_REPLAY_DEPLOYMENT));
    const nodeUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_exit_capacity", arguments: { network: "usdt0-replay" } } };
    const appWith = (path: string, mcpMaxReadsPerRequest?: number) =>
      createApp({
        db,
        logger: silentLogger,
        chain,
        mcpChain: createChainLayer({ deploymentsDir: dir, rpcUrls: { "usdt0-replay": `${nodeUrl}${path}` } }),
        corsOrigin: "*",
        mcpMaxReadsPerRequest,
      }).app;
    try {
      const bounded = await request(appWith("/bounded", 3)).post("/mcp").set(MCP_HEADERS).send(call).expect(200);
      expect(bounded.body.result.isError).toBe(true);
      expect(bounded.body.result.content[0].text).toMatch(/^This request needs more than 3 chain reads/);

      const unbounded = await request(appWith("/unbounded")).post("/mcp").set(MCP_HEADERS).send(call).expect(200);
      expect(unbounded.body.result.isError).toBeUndefined();
      expect(received["/unbounded"]).toBe(8);
      // The three reads the budget allowed were already on their way when the fourth was refused.
      await vi.waitFor(() => expect(received["/bounded"]).toBe(3));
    } finally {
      await new Promise((resolve) => node.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hands indexerUrl to get_history as the event index it reads", async () => {
    // A fills read uses only the network, market and underlying of the deployment.
    const testnet = { ...USDT0_REPLAY_DEPLOYMENT, network: "monad-testnet", chainId: 10143 };
    // An event index stand-in, indexed to block 500 with no fills, that records the paths it is asked on.
    const asked: string[] = [];
    const index = createServer((req, res) => {
      asked.push(req.url ?? "");
      req.resume();
      req.on("end", () => {
        const meta = { chainId: 10143, progressBlock: 500, sourceBlock: 505, isReady: true, readyAt: null };
        const market = { id: testnet.market.toLowerCase(), updatedAt: 1 };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: { _meta: [meta], market, fills: [], fees: [] } }));
      });
    });
    // A testnet node stand-in at block 505 that answers every eth_call with zero words.
    const node = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: method === "eth_blockNumber" ? "0x1f9" : `0x${"00".repeat(160)}` }));
      });
    });
    const urlOf = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const [indexUrl, nodeUrl] = await Promise.all([urlOf(index), urlOf(node)]);
    const dir = mkdtempSync(join(tmpdir(), "selio-mcp-"));
    writeFileSync(join(dir, "monad-testnet.json"), JSON.stringify(testnet));
    const call = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_history", arguments: { network: "monad-testnet", view: "fills" } },
    };
    const appWith = (indexerUrl?: string) =>
      createApp({
        db,
        logger: silentLogger,
        chain,
        mcpChain: createChainLayer({ deploymentsDir: dir, rpcUrls: { "monad-testnet": nodeUrl } }),
        corsOrigin: "*",
        indexerUrl,
      }).app;
    try {
      const reply = await request(appWith(`${indexUrl}/v1/graphql`)).post("/mcp").set(MCP_HEADERS).send(call).expect(200);
      expect(reply.body.result.isError).toBeUndefined();
      expect(JSON.parse(reply.body.result.content[0].text).index).toEqual({
        source: "Envio HyperIndex",
        indexedToBlock: 500,
        chainHead: 505,
        lagBlocks: 5,
        ready: true,
      });
      expect(asked).toEqual(["/v1/graphql"]);

      const unset = await request(appWith()).post("/mcp").set(MCP_HEADERS).send(call).expect(200);
      expect(unset.body.result.isError).toBe(true);
      expect(unset.body.result.content[0].text).toBe(
        "This MCP server has no Selio indexer configured (SELIO_INDEXER_URL, or INDEXER_URL on the hosted server).",
      );
      expect(asked).toHaveLength(1);
    } finally {
      await Promise.all([index, node].map((server) => new Promise((resolve) => server.close(resolve))));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects GET and DELETE in stateless mode", async () => {
    const get = await request(app).get("/mcp").expect(405);
    expect(get.headers.allow).toBe("POST");
    expect(get.body).toEqual({
      code: "METHOD_NOT_ALLOWED",
      message: "This MCP endpoint is stateless; send JSON-RPC requests with POST",
    });
    await request(app).delete("/mcp").expect(405);
  });
});

describe("fork RPC proxy", () => {
  it("forwards allowed methods on fork networks", async () => {
    const res = await request(app).post("/rpc/usdt0-replay").send({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }).expect(200);
    expect(res.body.result).toBe("0x8f");
    expect(rpcUpstream.send).toHaveBeenCalledWith("http://127.0.0.1/usdt0-replay", { jsonrpc: "2.0", id: 1, method: "eth_chainId" });
  });

  it("blocks anvil cheat methods and node-signed transactions", async () => {
    for (const method of ["anvil_setBalance", "eth_sendTransaction"]) {
      const res = await request(app).post("/rpc/usdt0-replay").send({ jsonrpc: "2.0", id: 1, method, params: [] }).expect(200);
      expect(res.body.error.code).toBe(-32601);
    }
    expect(rpcUpstream.send).not.toHaveBeenCalled();
  });

  it("is not offered for live networks or unknown ones", async () => {
    await request(app).post("/rpc/monad-testnet").send({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }).expect(404);
    await request(app).post("/rpc/mainnet").send({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }).expect(400);
  });
});
