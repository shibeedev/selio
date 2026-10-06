import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NETWORK_KEYS, defaultDeploymentsDir, envSuffix, loadMcpConfig } from "./config.js";

describe("loadMcpConfig", () => {
  it("reads SELIO_DEPLOYMENTS_DIR and SELIO_RPC_<KEY>, counting empty values as unset", () => {
    const config = loadMcpConfig({
      SELIO_DEPLOYMENTS_DIR: "/srv/selio/deployments",
      SELIO_RPC_USDT0_REPLAY: "http://127.0.0.1:8852",
      SELIO_RPC_MONAD_TESTNET: "",
      RPC_VAULT_FREEZE: "http://127.0.0.1:8853",
    });
    expect(config).toEqual({
      deploymentsDir: "/srv/selio/deployments",
      rpcUrls: { "usdt0-replay": "http://127.0.0.1:8852" },
    });
    expect(loadMcpConfig({ SELIO_DEPLOYMENTS_DIR: "" }).deploymentsDir).toBe(defaultDeploymentsDir());
  });

  it("defaults to the repository's contracts/deployments folder", () => {
    const packageDir = fileURLToPath(new URL("..", import.meta.url));
    expect(loadMcpConfig({})).toEqual({
      deploymentsDir: resolve(packageDir, "..", "..", join("contracts", "deployments")),
      rpcUrls: {},
    });
  });

  it("rejects an RPC value that is not a URL", () => {
    expect(() => loadMcpConfig({ SELIO_RPC_VAULT_FREEZE: "127.0.0.1:8604" })).toThrow(
      "Invalid configuration: SELIO_RPC_VAULT_FREEZE: must be a URL",
    );
    expect(() => loadMcpConfig({ SELIO_RPC_VAULT_FREEZE: "not a url" })).toThrow(
      "Invalid configuration: SELIO_RPC_VAULT_FREEZE: must be a URL",
    );
    expect(() => loadMcpConfig({ SELIO_RPC_MONAD_TESTNET: "testnet", SELIO_RPC_USDT0_REPLAY: " " })).toThrow(
      "Invalid configuration: SELIO_RPC_MONAD_TESTNET: must be a URL; SELIO_RPC_USDT0_REPLAY: must be a URL",
    );
  });

  it("names the variables after the network keys", () => {
    expect(envSuffix("usdt0-replay")).toBe("USDT0_REPLAY");
    expect(NETWORK_KEYS.map(envSuffix)).toEqual(["MONAD_TESTNET", "USDT0_REPLAY", "VAULT_FREEZE"]);
  });
});
