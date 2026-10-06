// Long-running demo forks for the web app and the backend, deployed and seeded with frozen state, auction sessions,
// limit bids and Selio Vault capital. Usage: npm run fork:up -w @selio/e2e -- --network=all [--reuse]
import { spawn } from "node:child_process";
import { encodeFunctionData, formatUnits, maxUint256, type Address, type Hex } from "viem";
import { NETWORKS, SelioClient, erc20Abi, morphoAbi, parseDeployment, type NetworkKey, type SessionParams } from "@selio/sdk";
import { LIQUIDITY_HELPER, bidderKit, borrowerKit, kitContext, refreeze, sellerKit, type KitContext } from "@selio/forkkit";
import { ensureAllowance, makeActors, makeClients, send, type Actor } from "./lib/chain.js";
import { FORK_HEADERS, deployToFork, forkSpecs, readDotEnv, toolEnv, type ForkSpec } from "./lib/env.js";
import { Recorder } from "./lib/report.js";
import { bankRun } from "./scenarios/morpho.js";

const DEMO_PORTS: Record<NetworkKey, number> = { "usdt0-replay": 8602, "monad-testnet": 8603, "vault-freeze": 8604 };

/** Top Hyperithm USDC Apex share holders on Monad, checked on chain. */
const HYPERITHM_HOLDERS: Address[] = [
  "0xD33847382f821094D9079256C25cA1794AB408c6",
  "0x2f46409cEc29bD5e8EFc1A3136FfD34AA90c5998",
  "0xC5682e404F3d68EA4b461f0a22DfE8d7155DE86A",
];

const USD = 10n ** 6n;

function log(line: string): void {
  process.stdout.write(line + "\n");
}

async function rpcUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts anvil so that it outlives this script. */
function startDetached(spec: ForkSpec): void {
  const args = ["--fork-url", spec.forkUrl, "--port", String(spec.port), "--host", "0.0.0.0", "--gas-limit", "100000000", "--silent"];
  for (const header of FORK_HEADERS) args.push("--fork-header", header);
  if (spec.forkBlock !== undefined) args.push("--fork-block-number", String(spec.forkBlock));
  const child = spawn("anvil", args, { env: toolEnv(), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function params(startBps: number, stepBps: number): SessionParams {
  return { startBps, stepBps, stepInterval: 3600, capBps: 2000, duration: 1209600, payMask: 0b1111 };
}

type Actors = [Actor, Actor, Actor, Actor, Actor];

async function seedAave(r: Recorder, sdk: SelioClient, kit: KitContext, actors: Actors): Promise<void> {
  const [seller1, seller2, borrower, bidder, depositor] = actors;
  const d = sdk.deployment;
  const leave = 0n;
  const [ausd, usdc] = d.payTokens as [Address, Address];
  const mask = (1 << d.payTokens.length) - 1;
  await r.step("positions: two stuck depositors, one same-asset borrower, funded bidders", async () => {
    await sellerKit(kit, seller1.address, 150n * USD, leave);
    await sellerKit(kit, seller2.address, 40n * USD, leave);
    await borrowerKit(kit, borrower.address, 80n * USD, leave);
    await bidderKit(kit, bidder.address, { [ausd]: 1_000_000n * USD, [usdc]: 1_000_000n * USD });
    await bidderKit(kit, depositor.address, { [d.underlying]: 200n * USD });
    await refreeze(kit, leave);
  });
  await r.step("sessions: 120 aMonUSDT0 from 1% rising 0.5%/h, 30 aMonUSDT0 from 3%", async () => {
    await ensureAllowance(r, sdk, seller1, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller1, sdk.openSession(120n * USD, { ...params(100, 50), payMask: mask }));
    await ensureAllowance(r, sdk, seller2, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller2, sdk.openSession(30n * USD, { ...params(300, 25), payMask: mask }));
  });
  await r.step("limit bids: AUSD at 2%, USDC at 4%, deeper AUSD at 8%", async () => {
    const bids: [number, number, bigint][] = [
      [200, 0, 10n * USD],
      [400, 1, 25n * USD],
      [800, 0, 60n * USD],
    ];
    for (const [bps, payIdx, size] of bids) {
      const token = d.payTokens[payIdx] as Address;
      const escrow = await sdk.quote(size, bps, token);
      await ensureAllowance(r, sdk, bidder, token, d.market, escrow);
      await send(r, sdk, bidder, sdk.placeBid(bps, payIdx, size, escrow));
    }
  });
  await r.step("Selio Vault: 200 USDT0 deposited (bids 3% for up to 20%)", async () => {
    await ensureAllowance(r, sdk, depositor, d.underlying, d.selioVault, 200n * USD);
    await send(r, sdk, depositor, sdk.vaultDeposit(200n * USD, depositor.address, await sdk.vaultPreviewDeposit(200n * USD)));
  });
}

async function seedMorpho(r: Recorder, sdk: SelioClient, kit: KitContext, actors: Actors, network: NetworkKey): Promise<void> {
  const [seller1, seller2, borrower, bidder, depositor] = actors;
  const d = sdk.deployment;
  const usdc = d.underlying;
  const morpho = d.morpho as Address;
  if (network === "monad-testnet") {
    await r.step("flash liquidity: 500,000 USDC idle in a separate Morpho market", async () => {
      const [loanToken, collateralToken, oracle, irm, lltv] = await sdk.client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [d.flashMarketId as Hex],
      });
      const amount = 500_000n * USD;
      await kit.anvil.setBalance(LIQUIDITY_HELPER, 10n ** 18n);
      await kit.anvil.dealErc20(usdc, LIQUIDITY_HELPER, amount);
      await kit.anvil.sendAs(
        LIQUIDITY_HELPER,
        usdc,
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [morpho, maxUint256] }),
      );
      await kit.anvil.sendAs(
        LIQUIDITY_HELPER,
        morpho,
        encodeFunctionData({
          abi: morphoAbi,
          functionName: "supply",
          args: [{ loanToken, collateralToken, oracle, irm, lltv }, amount, 0n, LIQUIDITY_HELPER, "0x"],
        }),
      );
    });
  }
  await r.step("positions: two stuck Earn depositors, one USDC borrower, funded bidders", async () => {
    await sellerKit(kit, seller1.address, 300_000n * USD);
    await sellerKit(kit, seller2.address, 80_000n * USD);
    await borrowerKit(kit, borrower.address, 200_000n * USD);
    await bidderKit(kit, bidder.address, { [usdc]: 2_000_000n * USD });
    await bidderKit(kit, depositor.address, { [usdc]: 500_000n * USD });
  });
  if (network === "vault-freeze") {
    await r.step("bank run: large Hyperithm USDC Apex holders withdraw what they can", async () => {
      const run = await bankRun(sdk, kit, HYPERITHM_HOLDERS.slice(0, 3));
      return { withdrawnUSDC: formatUnits(run.withdrawn, 6) };
    });
  }
  await r.step("freeze: remaining liquidity borrowed out", async () => {
    await refreeze(kit);
    return { utilization: `${(await sdk.capacity()).utilizationBps / 100}%` };
  });
  await r.step("sessions, limit bids and Selio Vault capital", async () => {
    await ensureAllowance(r, sdk, seller1, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller1, sdk.openSession(await sdk.receiptAmountFor(250_000n * USD), { ...params(100, 50), payMask: 0b11 }));
    await ensureAllowance(r, sdk, seller2, d.receipt, d.market, maxUint256 >> 1n);
    await send(r, sdk, seller2, sdk.openSession(await sdk.receiptAmountFor(60_000n * USD), { ...params(300, 25), payMask: 0b11 }));
    const bids: [number, bigint][] = [
      [200, 40_000n * USD],
      [500, 150_000n * USD],
      [900, 400_000n * USD],
    ];
    for (const [bps, size] of bids) {
      const escrow = await sdk.quote(size, bps, usdc);
      await ensureAllowance(r, sdk, bidder, usdc, d.market, escrow);
      await send(r, sdk, bidder, sdk.placeBid(bps, 0, size, escrow));
    }
    await ensureAllowance(r, sdk, depositor, usdc, d.selioVault, 500_000n * USD);
    await send(r, sdk, depositor, sdk.vaultDeposit(500_000n * USD, depositor.address, await sdk.vaultPreviewDeposit(500_000n * USD)));
  });
}

/** Starts (or, with `reuse`, adopts) the demo fork of `network`, deploys Selio and seeds it; false if a step failed. */
async function up(network: NetworkKey, specs: Record<NetworkKey, ForkSpec>, reuse: boolean): Promise<boolean> {
  const spec: ForkSpec = { ...specs[network], port: DEMO_PORTS[network] };
  const rpcUrl = `http://127.0.0.1:${spec.port}`;
  log(`\n== ${network} on ${rpcUrl}`);
  if (reuse) {
    // A supervisor (systemd on the demo server) runs the fork node.
    if (!(await rpcUp(rpcUrl))) throw new Error(`--reuse: nothing is serving on port ${spec.port}`);
  } else {
    if (await rpcUp(rpcUrl)) throw new Error(`port ${spec.port} is already serving; stop that node first`);
    startDetached(spec);
  }
  for (let i = 0; i < 120 && !(await rpcUp(rpcUrl)); i++) await new Promise((resolve) => setTimeout(resolve, 1000));
  const deployment = parseDeployment(await deployToFork(spec, { outDir: "./deployments/local/" }));
  const chain = { ...NETWORKS[network].chain, rpcUrls: { default: { http: [rpcUrl] } } };
  const { publicClient } = makeClients(rpcUrl, chain);
  const sdk = new SelioClient(deployment, publicClient);
  const kit = kitContext(publicClient, deployment);
  const actors = makeActors(["seller1", "seller2", "borrower", "bidder", "depositor"], rpcUrl, chain) as Actors;
  for (const a of actors) await kit.anvil.setBalance(a.address, 10n ** 20n);
  const r = new Recorder(network, log);
  if (deployment.venue === "aave") await seedAave(r, sdk, kit, actors);
  else await seedMorpho(r, sdk, kit, actors, network);
  const [c, sessions, bids] = await Promise.all([sdk.capacity(), sdk.sessions(true), sdk.bids()]);
  log(
    `  ready: market ${deployment.market}, utilization ${(c.utilizationBps / 100).toFixed(2)}%, ${sessions.length} sessions, ${bids.length} bids`,
  );
  return !r.hasFailed;
}

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith("--network="));
  const value = arg === undefined ? "all" : (arg.split("=")[1] as string);
  const networks = (value === "all" ? Object.keys(DEMO_PORTS) : value.split(",")) as NetworkKey[];
  const reuse = process.argv.includes("--reuse");
  const specs = forkSpecs(readDotEnv());
  for (const network of networks) {
    if (!(await up(network, specs, reuse))) process.exitCode = 1;
  }
  log("\nForks keep running in the background. Stop them by ending the anvil processes.");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
