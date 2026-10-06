import { describe, expect, it } from "vitest";
import { DEFAULT_DB_PATH, DEFAULT_DEPLOYMENTS_DIR, loadConfig } from "./index.js";

const slashes = (p: string) => p.replaceAll("\\", "/");

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.corsOrigin).toBe("*");
    expect(config.dbPath).toBe(DEFAULT_DB_PATH);
    expect(config.deploymentsDir).toBe(DEFAULT_DEPLOYMENTS_DIR);
    expect(slashes(config.dbPath)).toMatch(/apps\/backend\/data\/selio\.db$/);
    expect(slashes(config.deploymentsDir)).toMatch(/contracts\/deployments$/);
    expect(config.webhookSecret).toBeUndefined();
    expect("webhookSecret" in config).toBe(false);
    expect(config.rpcUrls).toEqual({});
  });

  it("reads overrides, treating blank values as unset", () => {
    const config = loadConfig({
      PORT: "9000",
      POLL_INTERVAL_MS: "",
      WEBHOOK_SECRET: "abc",
      RPC_USDT0_REPLAY: "http://127.0.0.1:8602",
      RPC_MONAD_TESTNET: "",
    });
    expect(config.port).toBe(9000);
    expect(config.pollIntervalMs).toBe(60_000);
    expect(config.webhookSecret).toBe("abc");
    expect(config.rpcUrls).toEqual({ "usdt0-replay": "http://127.0.0.1:8602" });
  });

  it("fails fast listing every invalid value", () => {
    expect(() => loadConfig({ PORT: "http", POLL_INTERVAL_MS: "10", RPC_VAULT_FREEZE: "not a url" })).toThrow(
      /^Invalid configuration: PORT.*POLL_INTERVAL_MS.*RPC_VAULT_FREEZE: must be a URL$/,
    );
  });

  it("reads the security limits and NODE_ENV", () => {
    const config = loadConfig({ RATE_LIMIT_API: "5", MCP_MAX_READS_PER_REQUEST: "7", NODE_ENV: "development" });
    expect(config.rateLimits.api).toBe(5);
    expect(config.mcpMaxReadsPerRequest).toBe(7);
    expect(config.allowLocalhostWebhooks).toBe(true);
    expect(loadConfig({ NODE_ENV: "production" }).allowLocalhostWebhooks).toBe(false);
    expect(() => loadConfig({ RATE_LIMIT_WINDOW_MS: "10" })).toThrow(/RATE_LIMIT_WINDOW_MS/);
  });
});
