import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const KEY = Buffer.alloc(32, 9).toString("base64");
const base = { CORS_ORIGIN: "https://selio.site", SELIO_WEBHOOK_SECRET: "s".repeat(64), AGENT_STORAGE_KEY: KEY };
const dynamic = {
  DYNAMIC_ENVIRONMENT_ID: "8f1d3c2b-4a5e-4f60-9b7a-0c1d2e3f4a5b",
  DYNAMIC_API_TOKEN: "dyn_token",
  DYNAMIC_WEBHOOK_SECRET: "whsec",
  DYNAMIC_DELEGATION_KEY_FILE: "/run/credentials/selio-agent.service/delegation.pem",
};

describe("loadConfig", () => {
  it("starts without Dynamic in the not-configured state, with the defaults", () => {
    const config = loadConfig({ ...base, PORT: "", DYNAMIC_API_TOKEN: "" });
    expect(config.dynamic).toBeNull();
    expect(config).toMatchObject({
      port: 8788,
      logLevel: "info",
      rpcUrl: "https://testnet-rpc.monad.xyz",
      mcpUrl: "http://127.0.0.1:8787/mcp",
      rateLimits: { windowMs: 60_000, api: 120 },
      agent: { cooldownMs: 300_000, maxGas: 3_000_000n, intentTtlMs: 120_000, maxGrantMs: 2_592_000_000 },
      shutdownGraceMs: 30_000,
    });
    expect(config.storageKey).toEqual(Buffer.alloc(32, 9));
    expect(config.dbPath.replace(/\\/g, "/")).toMatch(/apps\/agent\/data\/agent\.db$/);
    expect(config.deploymentsDir.replace(/\\/g, "/")).toMatch(/contracts\/deployments$/);
  });

  it("configures Dynamic when its credentials and the delegation key file are set", () => {
    expect(loadConfig({ ...base, ...dynamic }).dynamic).toEqual({
      environmentId: dynamic.DYNAMIC_ENVIRONMENT_ID,
      apiToken: "dyn_token",
      webhookSecret: "whsec",
      delegationKeyFile: dynamic.DYNAMIC_DELEGATION_KEY_FILE,
    });
  });

  it("refuses a partial Dynamic configuration and a missing key file", () => {
    expect(() => loadConfig({ ...base, DYNAMIC_ENVIRONMENT_ID: dynamic.DYNAMIC_ENVIRONMENT_ID })).toThrow(
      "Dynamic is partly configured: also set DYNAMIC_API_TOKEN, DYNAMIC_WEBHOOK_SECRET",
    );
    expect(() => loadConfig({ ...base, ...dynamic, DYNAMIC_DELEGATION_KEY_FILE: "" })).toThrow(
      "DYNAMIC_DELEGATION_KEY_FILE: Required when Dynamic is configured",
    );
    expect(() => loadConfig({ ...base, ...dynamic, DYNAMIC_ENVIRONMENT_ID: "env-1" })).toThrow("DYNAMIC_ENVIRONMENT_ID: Invalid uuid");
  });

  it("fails fast on missing required values and a bad storage key", () => {
    expect(() => loadConfig({})).toThrow(
      "Invalid configuration: CORS_ORIGIN: Required; SELIO_WEBHOOK_SECRET: Required; AGENT_STORAGE_KEY: Required",
    );
    expect(() => loadConfig({ ...base, AGENT_STORAGE_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      "AGENT_STORAGE_KEY: must be the base64 of 32 random bytes",
    );
    expect(() => loadConfig({ ...base, RPC_MONAD_TESTNET: "not a url" })).toThrow("RPC_MONAD_TESTNET: Invalid url");
  });
});
