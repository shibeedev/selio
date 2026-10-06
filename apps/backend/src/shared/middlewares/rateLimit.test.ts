import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, testDb } from "../../testing/fakes.js";
import type { Db } from "../db/database.js";
import { RateLimits } from "../db/rateLimits.js";
import { errorHandler } from "./errorHandler.js";
import { rateLimit } from "./rateLimit.js";

const WINDOW_MS = 60_000;

describe("rateLimit", () => {
  let db: Db;
  let clock: number;

  beforeEach(() => {
    db = testDb();
    clock = 10 * WINDOW_MS + 15_000; // 15 s into a window
  });
  afterEach(() => db.close());

  function app(max: { api: number; mcp: number; rpc: number }) {
    const a = express();
    a.use(rateLimit({ limits: new RateLimits(db), now: () => clock, windowMs: WINDOW_MS, max }));
    a.all("*", (_req, res) => {
      res.json({ ok: true });
    });
    a.use(errorHandler(silentLogger));
    return a;
  }

  it("answers 429 with Retry-After once an IP passes its group limit", async () => {
    const a = app({ api: 2, mcp: 10, rpc: 10 });
    await request(a).get("/api/networks").expect(200);
    await request(a).get("/api/networks").expect(200);
    const limited = await request(a).get("/api/networks").expect(429);
    expect(limited.headers["retry-after"]).toBe("45");
    expect(limited.body).toEqual({
      code: "RATE_LIMITED",
      message: "Too many requests; try again in 45s",
      details: { retryAfterSeconds: 45 },
    });

    clock += 45_000; // the next window
    await request(a).get("/api/networks").expect(200);
  });

  it("counts api, mcp and rpc apart, matches paths in any case and never limits health probes", async () => {
    const a = app({ api: 1, mcp: 1, rpc: 1 });
    await request(a).get("/api/alerts").expect(200);
    await request(a).get("/API/alerts").expect(429);
    await request(a).post("/mcp").expect(200);
    await request(a).post("/mcp").expect(429);
    await request(a).post("/rpc/usdt0-replay").expect(200);
    await request(a).post("/rpc/vault-freeze").expect(429);
    for (let i = 0; i < 5; i++) {
      await request(a).get("/healthz").expect(200);
      await request(a).get("/readyz").expect(200);
    }
    expect(db.prepare("SELECT key FROM rate_limit_hits ORDER BY key").all().map((r) => String(r.key).split(":")[0])).toEqual([
      "api",
      "mcp",
      "rpc",
    ]);
  });

  it("keys on CF-Connecting-IP and buckets IPv6 by /64", async () => {
    const a = app({ api: 1, mcp: 10, rpc: 10 });
    await request(a).get("/api/x").set("CF-Connecting-IP", "203.0.113.7").expect(200);
    await request(a).get("/api/x").set("CF-Connecting-IP", "198.51.100.9").expect(200);
    await request(a).get("/api/x").set("CF-Connecting-IP", "203.0.113.7").expect(429);

    await request(a).get("/api/x").set("CF-Connecting-IP", "2001:db8:1:2::1").expect(200);
    await request(a).get("/api/x").set("CF-Connecting-IP", "2001:db8:1:2::ff").expect(429);
    await request(a).get("/api/x").set("CF-Connecting-IP", "2001:db8:1:3::1").expect(200);

    // Without a valid header the socket address counts: the loopback client of this test.
    await request(a).get("/api/x").expect(200);
    await request(a).get("/api/x").set("CF-Connecting-IP", "not an ip").expect(429);
    const keys = db.prepare("SELECT key FROM rate_limit_hits ORDER BY key").all().map((r) => String(r.key));
    expect(keys).toContain("api:2001:db8:1:2::/64");
    expect(keys).toContain("api:127.0.0.1");
  });
});
