import { zeroAddress, type Address } from "viem";
import { z } from "zod";
import {
  IndexerClient,
  IndexerError,
  type IndexStatus,
  type IndexedAccount,
  type IndexedBid,
  type IndexedCapacityPoint,
  type IndexedFill,
  type IndexedSession,
  type IndexedVaultAction,
  type IndexedVaultState,
  type TokenInfo,
} from "@selio/sdk";
import { amountView, bpsView } from "../amounts.js";
import type { NetworkHandle } from "../chain.js";
import { ToolError } from "../errors.js";
import { addressSchema, networkSchema } from "../schemas.js";
import { optionalAddress, type ToolContext } from "./common.js";
import { CAPACITY_DISCOUNT_LEVELS, tokenRef } from "./read.js";

/** Rows per get_history page when the caller gives no limit. */
export const HISTORY_DEFAULT_LIMIT = 20;
/** Largest get_history page. */
export const HISTORY_MAX_LIMIT = 100;
/** Blocks behind the chain head that still count as up to date (about 15 s at 0.30 s blocks), as in the web app. */
export const HISTORY_LAG_OK_BLOCKS = 50;
/** Capacity window when the caller gives no sinceHours; HOUR buckets up to it, DAY buckets beyond. */
const CAPACITY_DEFAULT_HOURS = 168;

const DISPLAY_ONLY_NOTE =
  "History comes from the Selio event index (Envio HyperIndex) of monad-testnet and is for display only. Exit capacity, prices and every transaction must come from on-chain reads: use get_exit_capacity, list_sessions, list_bids or quote_purchase before building a transaction.";
const RECONSTRUCTED_NOTE =
  "Capacity points are reconstructed from events: they leave out interest not yet accrued on-chain and USDC sent to the Earn vault directly, and bids paying in a token other than the underlying count at their full remaining size (bidCapacityExact is then false).";
const WALLET_NEEDS_ADDRESS = 'view "wallet" needs an address.';

export const getHistoryShape = {
  network: networkSchema,
  view: z.enum(["fills", "auctions", "bids", "capacity", "vault", "wallet"]).describe("What to return. wallet needs address."),
  address: addressSchema.optional().describe("Wallet to filter by (fills, auctions, bids) or to summarise (wallet)."),
  sinceHours: z
    .number()
    .int()
    .min(1)
    .max(8760)
    .optional()
    .describe("Only activity from the last N hours. Default: everything (168 for capacity)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HISTORY_MAX_LIMIT)
    .optional()
    .describe(`Rows to return. Default ${HISTORY_DEFAULT_LIMIT}.`),
  cursor: z.string().regex(/^\d+$/).optional().describe("nextCursor of a previous call, to read the next page."),
};
export type GetHistoryArgs = z.infer<z.ZodObject<typeof getHistoryShape>>;

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

const BID_STATUS = { LIVE: "live", CANCELLED: "cancelled", CLOSED_AFTER_FILL: "closed after fill" } as const;

type Tokens = (address: Address) => TokenInfo;

/** Symbol and decimals of each distinct address, through the SDK's cached token reads. */
async function tokensOf(h: NetworkHandle, addresses: Address[]): Promise<Tokens> {
  const distinct = new Map<string, Address>();
  for (const address of addresses) if (!distinct.has(address.toLowerCase())) distinct.set(address.toLowerCase(), address);
  const infos = new Map<string, TokenInfo>();
  await Promise.all([...distinct].map(async ([key, address]) => infos.set(key, await h.sdk.token(address))));
  return (address) => infos.get(address.toLowerCase()) ?? { address, symbol: "?", decimals: 18 };
}

function fillItem(f: IndexedFill, tokens: Tokens, underlying: TokenInfo) {
  const pay = tokens(f.payToken);
  return {
    kind: f.kind,
    sessionId: f.sessionId.toString(),
    bidId: f.bidId === null ? null : f.bidId.toString(),
    seller: f.seller,
    buyer: f.buyer,
    buyerIsSelioVault: f.buyerIsSelioVault,
    receiptValue: amountView(f.assets, underlying),
    paid: amountView(f.paid, pay),
    fee: amountView(f.fee, pay),
    sellerReceived: amountView(f.sellerNet, pay),
    discount: bpsView(f.discountBps),
    debtRepaid: f.debtRepaid === null ? null : amountView(f.debtRepaid, underlying),
    time: iso(f.timestamp),
    block: f.blockNumber,
    txHash: f.txHash,
  };
}

function auctionItem(s: IndexedSession, underlying: TokenInfo) {
  return {
    sessionId: s.sessionId.toString(),
    seller: s.seller,
    startedAt: iso(s.startedAt),
    endsAt: iso(s.endsAt),
    schedule: {
      start: bpsView(s.startBps),
      step: bpsView(s.stepBps),
      stepIntervalSeconds: s.stepInterval,
      cap: bpsView(s.capBps),
    },
    opened: amountView(s.openedAssets, underlying),
    sold: amountView(s.soldAssets, underlying),
    withdrawn: amountView(s.withdrawnAssets, underlying),
    averageDiscount: s.avgDiscountBps === null ? null : bpsView(s.avgDiscountBps),
    fills: s.fills.map((f) => ({
      time: iso(f.timestamp),
      discount: bpsView(f.discountBps),
      receiptValue: amountView(f.assets, underlying),
    })),
  };
}

function bidItem(b: IndexedBid, tokens: Tokens, underlying: TokenInfo) {
  const pay = tokens(b.payToken);
  return {
    bidId: b.bidId.toString(),
    bidder: b.bidder,
    isSelioVault: b.isSelioVault,
    minDiscount: bpsView(b.minDiscountBps),
    payToken: tokenRef(pay),
    placed: { maxAssets: amountView(b.maxAssetsPlaced, underlying), escrow: amountView(b.escrowPlaced, pay) },
    remaining: { maxAssets: amountView(b.maxAssets, underlying), escrow: amountView(b.escrow, pay) },
    filled: amountView(b.filledAssets, underlying),
    status: BID_STATUS[b.status],
    placedAt: iso(b.placedAt),
    closedAt: b.closedAt === null ? null : iso(b.closedAt),
  };
}

function capacityItem(p: IndexedCapacityPoint, underlying: TokenInfo) {
  const depth = { 100: p.bidAt100, 300: p.bidAt300, 500: p.bidAt500, 1_000: p.bidAt1000, 2_000: p.bidAt2000 };
  return {
    time: iso(p.start),
    interval: p.interval === "HOUR" ? ("hour" as const) : ("day" as const),
    withdrawable: amountView(p.withdrawable, underlying),
    supplied: amountView(p.supplied, underlying),
    utilization: bpsView(p.utilizationBps),
    debtorCapacity: amountView(p.debtorCapacity, underlying),
    sessionAssets: amountView(p.sessionAssets, underlying),
    bidCapacity: CAPACITY_DISCOUNT_LEVELS.map((d) => ({ maxDiscount: bpsView(d), assets: amountView(depth[d], underlying) })),
    bidCapacityExact: p.bidCapacityExact,
  };
}

interface VaultTokens {
  underlying: TokenInfo;
  vaultShares: TokenInfo;
  receipt: TokenInfo;
  source: TokenInfo;
}

/** One Selio Vault action; `shares` are vault shares, `sourceShares` the yield source's shares (base yield). */
function vaultItem(a: IndexedVaultAction, t: VaultTokens) {
  const source = a.kind.startsWith("SOURCE_");
  return {
    kind: a.kind,
    account: a.account,
    receiver: a.receiver,
    assets: a.assets === null ? null : amountView(a.assets, t.underlying),
    shares: a.shares === null || source ? null : amountView(a.shares, t.vaultShares),
    sourceShares: a.shares === null || !source ? null : amountView(a.shares, t.source),
    receiptUnits: a.receiptUnits === null ? null : amountView(a.receiptUnits, t.receipt),
    sourceUtilization: a.utilizationBps === null ? null : bpsView(a.utilizationBps),
    time: iso(a.timestamp),
    block: a.blockNumber,
    txHash: a.txHash,
  };
}

function vaultSummary(s: IndexedVaultState, t: VaultTokens) {
  return {
    boughtFaceValue: amountView(s.boughtAssets, t.underlying),
    boughtCost: amountView(s.boughtCost, t.underlying),
    recovered: amountView(s.recoveredAssets, t.underlying),
    recoveryRate: s.recoveryRateBps === null ? null : bpsView(s.recoveryRateBps),
    costRecovered: s.costRecoveryBps === null ? null : bpsView(s.costRecoveryBps),
    totalAssets: amountView(s.totalAssets, t.underlying),
    idle: amountView(s.idle, t.underlying),
    sharesOutstanding: amountView(s.totalSupply, t.vaultShares),
  };
}

function walletSummary(a: IndexedAccount, tokens: Tokens, h: NetworkHandle) {
  const underlying = tokens(h.deployment.underlying);
  return {
    sold: amountView(a.soldAssets, underlying),
    bought: amountView(a.boughtAssets, underlying),
    debtRepaid: amountView(a.debtRepaid, underlying),
    sessionsOpened: a.sessionsOpened,
    bidsPlaced: a.bidsPlaced,
    receiptShares: amountView(a.receiptShares, tokens(h.deployment.receipt)),
    vaultShares: amountView(a.vaultShares, tokens(h.deployment.selioVault)),
    byToken: a.tokens.map((t) => {
      const token = tokens(t.token);
      return {
        token: tokenRef(token),
        receivedNet: amountView(t.receivedNet, token),
        feesPaid: amountView(t.feesPaid, token),
        paidAsBuyer: amountView(t.paidAsBuyer, token),
        escrowLive: amountView(t.escrowLive, token),
      };
    }),
  };
}

export type FillItem = ReturnType<typeof fillItem>;
export type AuctionItem = ReturnType<typeof auctionItem>;
export type BidItem = ReturnType<typeof bidItem>;
export type CapacityItem = ReturnType<typeof capacityItem>;
export type VaultItem = ReturnType<typeof vaultItem>;
export type VaultSummary = ReturnType<typeof vaultSummary>;
export type WalletSummary = ReturnType<typeof walletSummary>;

interface ViewInput {
  client: IndexerClient;
  h: NetworkHandle;
  address: Address | undefined;
  sinceHours: number | undefined;
  now: number;
  offset: number;
  limit: number;
}

interface ViewResult {
  status: IndexStatus;
  items: (FillItem | AuctionItem | BidItem | CapacityItem | VaultItem)[];
  account?: WalletSummary | null;
  vault?: VaultSummary | null;
}

const sinceOf = (v: ViewInput): number | undefined => (v.sinceHours === undefined ? undefined : v.now - v.sinceHours * 3600);
const pageOf = <T>(rows: T[], v: ViewInput): T[] => rows.slice(v.offset, v.offset + v.limit);

/** Awaits an index request; a failed request and a market the index does not know become tool errors. */
async function indexed<T extends { status: IndexStatus }>(h: NetworkHandle, request: Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await request;
  } catch (err) {
    if (err instanceof IndexerError) {
      throw new ToolError(`The Selio indexer did not answer: ${err.message}${err.offline ? " Try again shortly." : ""}`);
    }
    throw err;
  }
  if (!result.status.marketIndexed) {
    throw new ToolError(
      `The Selio indexer does not cover the monad-testnet market ${h.deployment.market}; it may still index an earlier deployment.`,
    );
  }
  return result;
}

const VIEWS: Record<GetHistoryArgs["view"], (v: ViewInput) => Promise<ViewResult>> = {
  async fills(v) {
    const { h } = v;
    const { status, fills } = await indexed(
      h,
      v.client.fills(h.deployment.market, { since: sinceOf(v), account: v.address, limit: v.limit, offset: v.offset }),
    );
    const tokens = await tokensOf(h, [h.deployment.underlying, ...fills.map((f) => f.payToken)]);
    return { status, items: fills.map((f) => fillItem(f, tokens, tokens(h.deployment.underlying))) };
  },

  async auctions(v) {
    const { h } = v;
    const { status, sessions } = await indexed(
      h,
      v.client.auctions(h.deployment.market, { since: sinceOf(v), seller: v.address, limit: v.limit, offset: v.offset }),
    );
    const underlying = await h.sdk.token(h.deployment.underlying);
    return { status, items: sessions.map((s) => auctionItem(s, underlying)) };
  },

  // The index returns a bidder's (or the market's) latest bids at once; pages are cut from them.
  async bids(v) {
    const { h } = v;
    const since = sinceOf(v);
    const { status, bids } = await indexed(h, v.client.bidderHistory(h.deployment.market, v.address));
    const page = pageOf(
      bids.filter((b) => since === undefined || b.placedAt >= since),
      v,
    );
    const tokens = await tokensOf(h, [h.deployment.underlying, ...page.map((b) => b.payToken)]);
    return { status, items: page.map((b) => bidItem(b, tokens, tokens(h.deployment.underlying))) };
  },

  // The point before the window comes first: it holds until the window's first point.
  async capacity(v) {
    const { h } = v;
    const hours = v.sinceHours ?? CAPACITY_DEFAULT_HOURS;
    const interval = hours <= CAPACITY_DEFAULT_HOURS ? "HOUR" : "DAY";
    const { status, seed, points } = await indexed(
      h,
      v.client.capacity(h.deployment.market, { interval, since: v.now - hours * 3600 }),
    );
    const underlying = await h.sdk.token(h.deployment.underlying);
    const rows = seed === null ? points : [seed, ...points];
    return { status, items: pageOf(rows, v).map((p) => capacityItem(p, underlying)) };
  },

  async vault(v) {
    const { h } = v;
    const d = h.deployment;
    const since = sinceOf(v);
    const { status, state, actions } = await indexed(
      h,
      v.client.vault(d.market, d.selioVault, { interval: "DAY", since: since ?? 0 }),
    );
    const page = pageOf(
      actions.filter((a) => since === undefined || a.timestamp >= since),
      v,
    );
    const needsSource = page.some((a) => a.kind.startsWith("SOURCE_") && a.shares !== null);
    const baseYield = needsSource ? await h.reads.vaultBaseYield() : null;
    const tokens = await tokensOf(h, [
      d.underlying,
      d.selioVault,
      d.receipt,
      ...(baseYield === null ? [] : [baseYield.source]),
    ]);
    const t: VaultTokens = {
      underlying: tokens(d.underlying),
      vaultShares: tokens(d.selioVault),
      receipt: tokens(d.receipt),
      source: tokens(baseYield?.source ?? zeroAddress),
    };
    return {
      status,
      items: page.map((a) => vaultItem(a, t)),
      vault: state === null ? null : vaultSummary(state, t),
    };
  },

  async wallet(v) {
    const { h } = v;
    if (v.address === undefined) throw new ToolError(WALLET_NEEDS_ADDRESS);
    const { status, account } = await indexed(h, v.client.wallet(h.deployment.market, v.address));
    if (account === null) return { status, items: [], account: null };
    const d = h.deployment;
    const tokens = await tokensOf(h, [d.underlying, d.receipt, d.selioVault, ...account.tokens.map((t) => t.token)]);
    return { status, items: [], account: walletSummary(account, tokens, h) };
  },
};

export async function getHistory(ctx: ToolContext, args: GetHistoryArgs) {
  const address = optionalAddress(args.address, "address");
  if (args.view === "wallet" && address === undefined) throw new ToolError(WALLET_NEEDS_ADDRESS);
  const h = ctx.chain.get(args.network);
  if (!h.info.indexed) {
    throw new ToolError(
      "History is indexed on monad-testnet only. usdt0-replay and vault-freeze are scenario forks reset every day; use list_sessions, list_bids and get_exit_capacity for their current state.",
    );
  }
  if (!ctx.indexerUrl) {
    throw new ToolError(
      "This MCP server has no Selio indexer configured (SELIO_INDEXER_URL, or INDEXER_URL on the hosted server).",
    );
  }
  const input: ViewInput = {
    client: new IndexerClient({ url: ctx.indexerUrl }),
    h,
    address,
    sinceHours: args.sinceHours,
    now: Number(ctx.nowSeconds?.() ?? BigInt(Math.floor(Date.now() / 1000))),
    offset: Number(args.cursor ?? "0"),
    limit: args.limit ?? HISTORY_DEFAULT_LIMIT,
  };
  // One chain read, run alongside the index query; when it fails the lag is unknown.
  const head = h.reads.blockNumber().then(Number, () => null);
  const result = await VIEWS[args.view](input);
  const chainHead = await head;
  const { status } = result;
  const lagBlocks = chainHead === null ? null : Math.max(0, chainHead - status.progressBlock);
  const notes = [DISPLAY_ONLY_NOTE];
  if (!status.isReady || (lagBlocks !== null && lagBlocks > HISTORY_LAG_OK_BLOCKS)) {
    notes.push(`The index is behind the chain: activity after block ${status.progressBlock} is not included yet.`);
  }
  if (args.view === "capacity") notes.push(RECONSTRUCTED_NOTE);
  return {
    network: args.network,
    view: args.view,
    market: h.deployment.market,
    index: {
      source: "Envio HyperIndex",
      indexedToBlock: status.progressBlock,
      chainHead,
      lagBlocks,
      ready: status.isReady,
    },
    items: result.items,
    ...(args.view === "wallet" ? { account: result.account ?? null } : {}),
    ...(args.view === "vault" ? { vault: result.vault ?? null } : {}),
    ...(result.items.length === input.limit ? { nextCursor: String(input.offset + result.items.length) } : {}),
    notes,
  };
}
