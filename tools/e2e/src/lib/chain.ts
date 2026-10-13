import {
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  http,
  maxUint256,
  parseAbi,
  parseEventLogs,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  morphoVaultExitMarketAbi,
  priceRouterAbi,
  selioVaultAbi,
  testTokenAbi,
  type SelioClient,
  type UnsignedTx,
} from "@selio/sdk";
import { check, type Recorder } from "./report.js";

/** Private keys of anvil's default accounts #1-#9, in the order anvil prints them. */
const TEST_KEYS: readonly Hex[] = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

/** Same set as the web app: market, vault and route errors plus the price router's and the test token's. */
const ERROR_ABIS: readonly Abi[] = [
  aaveExitMarketAbi,
  morphoVaultExitMarketAbi,
  selioVaultAbi,
  aaveCollateralRouteAbi,
  priceRouterAbi,
  testTokenAbi,
];

export interface Actor {
  name: string;
  account: PrivateKeyAccount;
  address: Address;
  wallet: WalletClient;
}

let nextRequestAt = 0;

/**
 * Spaces requests to a public RPC (Monad's testnet RPC allows 15 per second) and resends the ones its rate limiter
 * refused: it answers them with JSON-RPC error -32011, which viem does not retry, before executing anything.
 */
async function rateLimitedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const at = Math.max(now, nextRequestAt);
    nextRequestAt = at + 100;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    const res = await fetch(input, init);
    if (attempt < 5 && /"code"\s*:\s*-32011/.test(await res.clone().text())) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    return res;
  }
}

/** Local fork nodes take requests as fast as they come; any other RPC gets the rate-limited fetch. */
function transport(rpcUrl: string) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl);
  return http(rpcUrl, { timeout: 120_000, ...(local ? {} : { fetchFn: rateLimitedFetch }) });
}

export function makeClients(rpcUrl: string, chain: Chain): { publicClient: PublicClient } {
  const publicClient = createPublicClient({ chain, transport: transport(rpcUrl) }) as PublicClient;
  return { publicClient };
}

export function makeActors(names: string[], rpcUrl: string, chain: Chain, keys: readonly Hex[] = TEST_KEYS): Actor[] {
  return names.map((name, i) => {
    const key = keys[i];
    if (!key) throw new Error(`no key for actor ${name}`);
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain, transport: transport(rpcUrl) });
    return { name, account, address: account.address, wallet };
  });
}

function revertData(e: unknown): Hex | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const found = e.walk((err) => typeof (err as { data?: unknown }).data === "string") as { data?: Hex } | null;
  return found?.data;
}

/** Decodes a revert into `ErrorName(arg, ...)`, or `revert <selector>` when no Selio ABI knows it. */
export function explain(e: unknown): string {
  const data = revertData(e);
  if (data && data.length >= 10) {
    for (const abi of ERROR_ABIS) {
      try {
        const { errorName, args } = decodeErrorResult({ abi, data });
        return `${errorName}(${(args ?? []).map((a) => String(a)).join(", ")})`;
      } catch {
        // not an error of this ABI
      }
    }
    return `revert ${data.slice(0, 10)}`;
  }
  if (e instanceof BaseError) return e.shortMessage;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Simulates, estimates, sends with a 30% gas buffer and waits for a successful receipt. */
export async function send(
  r: Recorder,
  sdk: SelioClient,
  actor: Actor,
  tx: UnsignedTx,
): Promise<{ hash: Hex; gasUsed: bigint }> {
  try {
    await sdk.simulate(tx, actor.address);
  } catch (e) {
    throw new Error(`simulation failed for "${tx.description}" from ${actor.name}: ${explain(e)}`);
  }
  const estimate = await sdk.client.estimateGas({ account: actor.address, to: tx.to, data: tx.data, value: tx.value });
  // Execution can take costlier branches than the estimate saw (e.g. Aave disabling collateral).
  const hash = await actor.wallet.sendTransaction({
    account: actor.account,
    chain: actor.wallet.chain,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: (estimate * 13n) / 10n,
  });
  r.noteTx(hash);
  const receipt = await sdk.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${tx.description} (${hash})`);
  return { hash, gasUsed: receipt.gasUsed };
}

/** Approves `spender` for an unlimited amount when the current allowance is below `amount`. */
export async function ensureAllowance(
  r: Recorder,
  sdk: SelioClient,
  actor: Actor,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  if ((await sdk.allowance(token, actor.address, spender)) >= amount) return;
  await send(r, sdk, actor, sdk.approve(token, spender, maxUint256));
}

/**
 * Totals of the fills a transaction made on the market (its `BidFilled` and `Bought` events), after checking that
 * each fill's fee is its payment times `FEE_BPS` / 10,000, rounded down.
 */
export async function fillTotals(
  sdk: SelioClient,
  hash: Hex,
): Promise<{ count: number; assets: bigint; paid: bigint; fee: bigint }> {
  const receipt = await sdk.client.getTransactionReceipt({ hash });
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === sdk.market.toLowerCase());
  const events = parseEventLogs({ abi: aaveExitMarketAbi, logs, eventName: ["BidFilled", "Bought"] });
  const feeBps = BigInt(await sdk.feeBps());
  const totals = { count: events.length, assets: 0n, paid: 0n, fee: 0n };
  for (const { args } of events) {
    check(args.fee === (args.paid * feeBps) / 10_000n, `fee rounding: ${args.fee} on ${args.paid}`);
    totals.assets += args.assets;
    totals.paid += args.paid;
    totals.fee += args.fee;
  }
  return totals;
}

const vaultKuruAbi = parseAbi([
  "function kuruShareBps() view returns (uint16)",
  "function kuruLeg(uint256 i) view returns (address book, address margin, address wrapper, uint40 orderId, uint32 price, uint96 placedSize, uint256 escrow, uint256 baseAtPlace)",
  "function kuruOrderState(uint256 i) view returns (bool active, uint96 remainingSize, uint256 refundValue, uint256 pendingCost)",
]);

/**
 * The Selio Vault's Kuru leg on strategy 0: its Kuru order book (zero when the strategy has none), the quote its
 * resting order debited, the part of that quote a cancel would not return (counted in `heldCost`), and the share of
 * the vault's room under the cap it may quote on Kuru.
 */
export async function vaultKuru(
  sdk: SelioClient,
): Promise<{ book: Address; escrow: bigint; pendingCost: bigint; shareBps: number }> {
  const vault = sdk.deployment.selioVault;
  const [leg, state, shareBps] = await Promise.all([
    sdk.client.readContract({ address: vault, abi: vaultKuruAbi, functionName: "kuruLeg", args: [0n] }),
    sdk.client.readContract({ address: vault, abi: vaultKuruAbi, functionName: "kuruOrderState", args: [0n] }),
    sdk.client.readContract({ address: vault, abi: vaultKuruAbi, functionName: "kuruShareBps" }),
  ]);
  return { book: leg[0], escrow: leg[6], pendingCost: state[3], shareBps };
}

/** Simulates `tx` and returns the decoded revert reason; throws when the call succeeds. Never sends. */
export async function expectRevert(sdk: SelioClient, actor: Actor, tx: UnsignedTx): Promise<string> {
  try {
    await sdk.simulate(tx, actor.address);
  } catch (e) {
    return explain(e);
  }
  throw new Error(`expected "${tx.description}" to revert`);
}
