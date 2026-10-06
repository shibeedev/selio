import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NETWORKS, type Deployment } from "@selio/sdk";
import { RpcChainLayer } from "./chain.js";
import { ToolError } from "./errors.js";
import { AAVE_DEPLOYMENT, ADDR, MORPHO_DEPLOYMENT, a } from "./testing/fakes.js";

const TESTNET: Deployment = { ...MORPHO_DEPLOYMENT, network: "monad-testnet", chainId: 10143 };
const dirs: string[] = [];

/** A deployments folder holding the given files (objects are written as JSON, strings as they are). */
function deployments(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "selio-mcp-chain-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  return dir;
}

function write(dir: string, name: string, content: unknown): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RpcChainLayer", () => {
  it("uses local/ deployments only for forks or networks whose RPC is overridden, and prefers the committed file", () => {
    const dir = deployments({ "local/usdt0-replay.json": AAVE_DEPLOYMENT, "local/monad-testnet.json": TESTNET });
    const layer = new RpcChainLayer({ deploymentsDir: dir });
    expect(layer.get("usdt0-replay").deployment.market).toBe(ADDR.market);
    expect(() => layer.get("monad-testnet")).toThrow(
      "No Selio deployment found for monad-testnet. Use list_networks to see deployed networks.",
    );
    expect(layer.list().map((n) => n.deployment !== null)).toEqual([false, true, false]);

    const overridden = new RpcChainLayer({ deploymentsDir: dir, rpcUrls: { "monad-testnet": "http://127.0.0.1:8850" } });
    expect(overridden.get("monad-testnet").deployment.market).toBe(ADDR.morphoMarket);
    write(dir, "monad-testnet.json", { ...TESTNET, market: a(0x3001) });
    expect(overridden.get("monad-testnet").deployment.market).toBe(a(0x3001));
  });

  it("treats a file for another network or an unreadable file as undeployed, and get reports a ToolError", () => {
    const { market: _market, ...withoutMarket } = MORPHO_DEPLOYMENT;
    const dir = deployments({
      "usdt0-replay.json": { ...AAVE_DEPLOYMENT, network: "vault-freeze" },
      "vault-freeze.json": "{ not json",
      "monad-testnet.json": { ...withoutMarket, network: "monad-testnet" },
    });
    const layer = new RpcChainLayer({ deploymentsDir: dir });
    expect(layer.list().map((n) => n.deployment)).toEqual([null, null, null]);
    expect(() => layer.get("usdt0-replay")).toThrow(ToolError);
    expect(() => layer.get("usdt0-replay")).toThrow(/usdt0-replay\.json describes vault-freeze, not usdt0-replay$/);
    expect(() => layer.get("vault-freeze")).toThrow(ToolError);
    expect(() => layer.get("vault-freeze")).toThrow(/vault-freeze\.json is not a valid Selio deployment file: /);
    expect(() => layer.get("monad-testnet")).toThrow(/deployment: missing market$/);
  });

  it("keeps a network's clients while its deployment file is unchanged", () => {
    const dir = deployments({ "usdt0-replay.json": AAVE_DEPLOYMENT });
    const layer = new RpcChainLayer({ deploymentsDir: dir });
    const first = layer.get("usdt0-replay");
    expect(layer.get("usdt0-replay")).toBe(first);
    const path = write(dir, "usdt0-replay.json", { ...AAVE_DEPLOYMENT, market: a(0x3002) });
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    const second = layer.get("usdt0-replay");
    expect(second).not.toBe(first);
    expect(second.deployment.market).toBe(a(0x3002));
  });

  it("uses the SDK's default RPC URL unless one is given", () => {
    const layer = new RpcChainLayer({ rpcUrls: { "vault-freeze": "http://127.0.0.1:8851" } });
    expect(layer.rpcUrl("usdt0-replay")).toBe(NETWORKS["usdt0-replay"].defaultRpcUrl);
    expect(layer.rpcUrl("vault-freeze")).toBe("http://127.0.0.1:8851");
  });
});
