// Unattended end-to-end runner. Usage:
//   npm run e2e -w @selio/e2e -- --network=all              (forks of all three networks)
//   npm run e2e -w @selio/e2e -- --network=monad-testnet --live   (live Monad Testnet, testnet funds)
//   npm run e2e -w @selio/e2e -- --network=monad-testnet --rehearse
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { NETWORKS, SelioClient, parseDeployment, type NetworkKey } from "@selio/sdk";
import { Anvil, kitContext } from "@selio/forkkit";
import { makeActors, makeClients } from "./lib/chain.js";
import { REPO_ROOT, CONTRACTS_DIR, deployToFork, forkSpecs, readDotEnv, startAnvil, type ForkSpec } from "./lib/env.js";
import { Recorder, toMarkdown, type ScenarioResult } from "./lib/report.js";
import { aaveScenario } from "./scenarios/aave.js";
import { liveMorphoScenario } from "./scenarios/live-morpho.js";
import { morphoScenario } from "./scenarios/morpho.js";

/** Top Hyperithm USDC Apex share holders on Monad, checked on chain. */
const HYPERITHM_HOLDERS: Address[] = [
  "0xD33847382f821094D9079256C25cA1794AB408c6",
  "0x2f46409cEc29bD5e8EFc1A3136FfD34AA90c5998",
  "0xC5682e404F3d68EA4b461f0a22DfE8d7155DE86A",
];

const ALL: NetworkKey[] = ["usdt0-replay", "monad-testnet", "vault-freeze"];

type Mode = "fork" | "live" | "rehearse";

function parseArgs(): { networks: NetworkKey[]; mode: Mode } {
  const arg = process.argv.find((a) => a.startsWith("--network="));
  const value = arg === undefined ? "all" : (arg.split("=")[1] as string);
  const names = value === "all" ? ALL : value.split(",");
  for (const n of names) {
    if (!(ALL as string[]).includes(n)) throw new Error(`unknown network ${n}`);
  }
  const mode: Mode = process.argv.includes("--live") ? "live" : process.argv.includes("--rehearse") ? "rehearse" : "fork";
  return { networks: names as NetworkKey[], mode };
}

function log(line: string): void {
  process.stdout.write(line + "\n");
}

async function waitForRpc(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`anvil at ${url} did not start`);
}

function runnerFailure(r: Recorder, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  r.steps.push({ name: "runner", ok: false, ms: 0, details: {}, txs: [], error: message });
  log(`  ✗ runner: ${message}`);
}

const LIVE_RPC_ENV: Partial<Record<NetworkKey, string>> = { "monad-testnet": "MONAD_TESTNET_RPC" };

async function runLive(network: NetworkKey, env: Record<string, string>, rehearse: boolean, spec: ForkSpec): Promise<ScenarioResult> {
  const t0 = Date.now();
  const r = new Recorder(network, log);
  const result: ScenarioResult = {
    network,
    mode: rehearse ? "fork" : "live",
    steps: r.steps,
    startedAt: new Date(t0).toISOString(),
    ms: 0,
  };
  log(`\n== ${network} (${rehearse ? "rehearsal of the live run on a fork" : "live"})`);
  let anvil: ReturnType<typeof startAnvil> | undefined;
  try {
    const rpcEnv = LIVE_RPC_ENV[network];
    if (!rpcEnv) throw new Error("live runs exist for live networks only");
    const keys = [env.PRIVATE_KEY, env.E2E_BUYER_KEY];
    const [sellerKey, buyerKey] = keys;
    if (!sellerKey || !buyerKey) throw new Error("PRIVATE_KEY and E2E_BUYER_KEY must be set in .env");
    let rpcUrl = env[rpcEnv] ?? NETWORKS[network].defaultRpcUrl;
    let raw: unknown;
    if (rehearse) {
      log(`  starting anvil on :${spec.port}${spec.forkBlock !== undefined ? ` at block ${spec.forkBlock}` : ""}`);
      anvil = startAnvil(spec);
      rpcUrl = `http://127.0.0.1:${spec.port}`;
      await waitForRpc(rpcUrl);
      const probe = makeClients(rpcUrl, NETWORKS[network].chain).publicClient;
      for (const key of [sellerKey, buyerKey]) await new Anvil(probe).setBalance(privateKeyToAddress(key as Hex), 10n ** 17n);
      raw = await deployToFork(spec, { key: sellerKey, outDir: "./deployments/local/rehearse/" });
    } else {
      const file = join(CONTRACTS_DIR, "deployments", `${network}.json`);
      if (!existsSync(file)) throw new Error(`no live deployment at ${file}`);
      raw = JSON.parse(readFileSync(file, "utf8"));
    }
    const deployment = parseDeployment(raw);
    result.deployment = deployment as unknown as Record<string, unknown>;
    const chain = { ...NETWORKS[network].chain, rpcUrls: { default: { http: [rpcUrl] } } };
    const { publicClient } = makeClients(rpcUrl, chain);
    result.forkBlock = String(await publicClient.getBlockNumber());
    const [seller, buyer] = makeActors(["seller", "buyer"], rpcUrl, chain, [sellerKey as Hex, buyerKey as Hex]);
    if (!seller || !buyer) throw new Error("actors");
    await liveMorphoScenario(r, new SelioClient(deployment, publicClient), { seller, buyer });
  } catch (e) {
    runnerFailure(r, e);
  } finally {
    anvil?.kill();
    result.ms = Date.now() - t0;
  }
  return result;
}

async function runFork(spec: ForkSpec): Promise<ScenarioResult> {
  const network = spec.network;
  const t0 = Date.now();
  const r = new Recorder(network, log);
  const result: ScenarioResult = { network, mode: "fork", steps: r.steps, startedAt: new Date(t0).toISOString(), ms: 0 };
  const rpcUrl = `http://127.0.0.1:${spec.port}`;
  log(`\n== ${network} (fork)`);
  log(`  starting anvil on :${spec.port}${spec.forkBlock !== undefined ? ` at block ${spec.forkBlock}` : ""}`);
  const anvil = startAnvil(spec);
  try {
    await waitForRpc(rpcUrl);
    const chain = { ...NETWORKS[network].chain, rpcUrls: { default: { http: [rpcUrl] } } };
    const { publicClient } = makeClients(rpcUrl, chain);
    result.forkBlock = String(await publicClient.getBlockNumber());
    let sdk = undefined as SelioClient | undefined;
    await r.step("deploy Selio contracts to the fork with the Foundry script", async () => {
      const deployment = parseDeployment(await deployToFork(spec));
      result.deployment = deployment as unknown as Record<string, unknown>;
      sdk = new SelioClient(deployment, publicClient);
      return { market: deployment.market, selioVault: deployment.selioVault };
    });
    if (!sdk) return result;
    const kit = kitContext(publicClient, sdk.deployment);
    if (NETWORKS[network].venue === "aave") {
      const actors = makeActors(["seller", "buyer", "bidder", "depositor", "borrower", "keeper"], rpcUrl, chain);
      const [seller, buyer, bidder, depositor, borrower, keeper] = actors;
      if (!seller || !buyer || !bidder || !depositor || !borrower || !keeper) throw new Error("actors");
      for (const a of actors) await kit.anvil.setBalance(a.address, 10n ** 19n);
      await aaveScenario(r, sdk, kit, { seller, buyer, bidder, depositor, borrower, keeper }, { leave: 0n });
    } else {
      const actors = makeActors(["seller", "buyer", "bidder", "depositor", "keeper"], rpcUrl, chain);
      const [seller, buyer, bidder, depositor, keeper] = actors;
      if (!seller || !buyer || !bidder || !depositor || !keeper) throw new Error("actors");
      for (const a of actors) await kit.anvil.setBalance(a.address, 10n ** 19n);
      await morphoScenario(r, sdk, kit, { seller, buyer, bidder, depositor, keeper }, {
        seedFlashLiquidity: network === "monad-testnet" ? 50_000n * 10n ** 6n : undefined,
        bankRunHolders: network === "vault-freeze" ? HYPERITHM_HOLDERS : undefined,
        forceDeallocate: network === "vault-freeze",
        baseYield: network === "monad-testnet",
      });
    }
  } catch (e) {
    runnerFailure(r, e);
  } finally {
    anvil.kill();
    result.ms = Date.now() - t0;
  }
  return result;
}

async function main(): Promise<void> {
  const { networks, mode } = parseArgs();
  const env = readDotEnv();
  const specs = forkSpecs(env);
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  for (const network of networks) {
    results.push(mode === "fork" ? await runFork(specs[network]) : await runLive(network, env, mode === "rehearse", specs[network]));
  }
  const dir = join(REPO_ROOT, "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const markdown = toMarkdown(results, startedAt);
  const json = JSON.stringify(results, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value), 2);
  writeFileSync(join(dir, `e2e-${mode}-${stamp}.json`), json);
  writeFileSync(join(dir, `e2e-${mode}-${stamp}.md`), markdown);
  writeFileSync(join(dir, `e2e-${mode}-latest.md`), markdown);
  const steps = results.flatMap((res) => res.steps);
  const passed = steps.filter((s) => s.ok).length;
  log(`\n${passed}/${steps.length} steps passed. Report: reports/e2e-${mode}-${stamp}.md`);
  process.exitCode = passed === steps.length ? 0 : 1;
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
