import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { NETWORKS } from "./networks.js";

// Client of the Selio event index (Envio HyperIndex, GraphQL over HTTPS). Indexed data is for display only:
// quotes, capacity, bid books and every transaction are read from the chain.

/** Most sessions `sellerHistory` returns, newest first. */
export const SELLER_SESSIONS_LIMIT = 500;
/** Most fills `sellerHistory` returns, newest first. */
export const SELLER_FILLS_LIMIT = 1_000;
/** Most bids `bidderHistory` returns, newest first. */
export const BIDDER_BIDS_LIMIT = 500;
/** Most vault actions `vault` returns, newest first. */
export const VAULT_ACTIONS_LIMIT = 50;
/** Capacity points `capacity` returns when the caller gives no limit. */
export const CAPACITY_POINTS_LIMIT = 1_000;
/** The web app's request timeout. */
const DEFAULT_TIMEOUT_MS = 8_000;

const FILL_KINDS = ["BORROWER_WALLET", "BORROWER_COLLATERAL", "SELL_NOW", "AUCTION_MATCH"] as const;
const BID_STATUSES = ["LIVE", "CANCELLED", "CLOSED_AFTER_FILL"] as const;
const INTERVALS = ["HOUR", "DAY"] as const;
const VAULT_ACTION_KINDS = [
  "DEPOSIT",
  "REDEEM",
  "RECOVER",
  "DEFER",
  "CLAIM",
  "SOURCE_DEPOSIT",
  "SOURCE_WITHDRAW",
  "SOURCE_PULL",
  "SOURCE_IN_KIND",
] as const;

export type IndexedFillKind = (typeof FILL_KINDS)[number];
export type IndexedBidStatus = (typeof BID_STATUSES)[number];
/** Bucket size of capacity points and vault points. */
export type IndexedInterval = (typeof INTERVALS)[number];
export type IndexedVaultActionKind = (typeof VAULT_ACTION_KINDS)[number];

export interface IndexStatus {
  chainId: number;
  /** Last block fully processed and written. */
  progressBlock: number;
  /** Chain head seen by the index's data source. */
  sourceBlock: number | null;
  /** Historical sync has finished. */
  isReady: boolean;
  readyAt: string | null;
  /** The market has a row in the index. */
  marketIndexed: boolean;
}

/** A failed index request: `offline` for a network error, timeout or non-JSON answer; `status` for an HTTP error. */
export class IndexerError extends Error {
  constructor(
    message: string,
    /** Network error, timeout or non-JSON answer. */
    readonly offline: boolean,
    /** HTTP status of a non-OK answer (429 = rate limited); 200 for GraphQL-level errors; null when offline. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = "IndexerError";
  }
}

export interface IndexedFill {
  kind: IndexedFillKind;
  /** 0 for a sell-now fill. */
  sessionId: bigint;
  /** null for a borrower purchase. */
  bidId: bigint | null;
  seller: Address;
  buyer: Address;
  buyerIsSelioVault: boolean;
  /** Receipt value, in the underlying. */
  assets: bigint;
  /** What the buyer or the bid paid, in `payToken`. */
  paid: bigint;
  /** Protocol fee taken from `paid`. */
  fee: bigint;
  /** What the seller received: `paid − fee`. */
  sellerNet: bigint;
  payToken: Address;
  discountBps: number;
  /** Debt repaid by a borrower purchase; null for bid fills. */
  debtRepaid: bigint | null;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: Hex;
  txFrom: Address;
}

export interface IndexedSession {
  sessionId: bigint;
  seller: Address;
  startedAt: number;
  endsAt: number;
  startBps: number;
  stepBps: number;
  stepInterval: number;
  capBps: number;
  openedAssets: bigint;
  soldAssets: bigint;
  withdrawnAssets: bigint;
  /** Receipt value still listed (reconstructed from events). */
  listedAssets: bigint;
  fillCount: number;
  /** Value-weighted average discount of the fills; null before the first fill. */
  avgDiscountBps: number | null;
  /** Oldest first. */
  fills: { timestamp: number; discountBps: number; assets: bigint; kind: IndexedFillKind }[];
}

export interface IndexedBid {
  bidId: bigint;
  bidder: Address;
  isSelioVault: boolean;
  minDiscountBps: number;
  payToken: Address;
  maxAssetsPlaced: bigint;
  escrowPlaced: bigint;
  /** Remaining size. */
  maxAssets: bigint;
  /** Remaining escrow. */
  escrow: bigint;
  filledAssets: bigint;
  paidOut: bigint;
  status: IndexedBidStatus;
  placedAt: number;
  closedAt: number | null;
}

/** Exit capacity and bid depth at the last event of a bucket (reconstructed from events). */
export interface IndexedCapacityPoint {
  interval: IndexedInterval;
  /** Bucket start, Unix seconds. */
  start: number;
  updatedAt: number;
  blockNumber: number;
  withdrawable: bigint;
  supplied: bigint;
  utilizationBps: number;
  debtorCapacity: bigint;
  sessionAssets: bigint;
  bidAt100: bigint;
  bidAt300: bigint;
  bidAt500: bigint;
  bidAt1000: bigint;
  bidAt2000: bigint;
  /** False when a live bid pays in a token other than the underlying (it counts at its remaining size). */
  bidCapacityExact: boolean;
}

export interface IndexedFeeTotal {
  payToken: Address;
  fees: bigint;
  gross: bigint;
  sellerNet: bigint;
  fillCount: number;
}

export interface IndexedVaultState {
  asset: Address;
  totalSupply: bigint;
  totalAssets: bigint;
  idle: bigint;
  /** Asset base units per whole vault share (display only). */
  assetsPerShare: bigint;
  depositedAssets: bigint;
  redeemedAssets: bigint;
  redeemedReceiptUnits: bigint;
  boughtAssets: bigint;
  boughtCost: bigint;
  boughtFills: number;
  recoveredAssets: bigint;
  recoveryRateBps: number | null;
  costRecoveryBps: number | null;
  deferredUnits: bigint;
  claimedUnits: bigint;
  /** Yield-source shares the vault deposited and still holds (base yield). */
  sourceShares: bigint;
  sourceDepositedAssets: bigint;
  sourceWithdrawnAssets: bigint;
  sourcePulledAssets: bigint;
  sourceSharesInKind: bigint;
  /** Source utilization reported by the latest pull-back; null before the first one. */
  lastPullUtilizationBps: number | null;
  liveBid: { bidId: bigint; capacityAssets: bigint } | null;
  updatedAt: number;
}

/** Selio Vault state at the last event of a bucket. */
export interface IndexedVaultPoint {
  interval: IndexedInterval;
  start: number;
  totalAssets: bigint;
  idle: bigint;
  totalSupply: bigint;
  assetsPerShare: bigint;
  depositedAssets: bigint;
  redeemedAssets: bigint;
  recoveredAssets: bigint;
  boughtAssets: bigint;
  boughtCost: bigint;
  sourceShares: bigint;
}

export interface IndexedVaultAction {
  kind: IndexedVaultActionKind;
  /** The Selio Vault itself for SOURCE_DEPOSIT, SOURCE_WITHDRAW and SOURCE_PULL. */
  account: Address;
  receiver: Address | null;
  /** In the vault asset. */
  assets: bigint | null;
  /** Vault shares, or yield-source shares for the SOURCE_* kinds. */
  shares: bigint | null;
  receiptUnits: bigint | null;
  /** Source utilization of a SOURCE_PULL. */
  utilizationBps: number | null;
  timestamp: number;
  blockNumber: number;
  logIndex: number;
  txHash: Hex;
}

export interface IndexedAccount {
  receiptShares: bigint;
  vaultShares: bigint;
  sessionsOpened: number;
  soldAssets: bigint;
  boughtAssets: bigint;
  debtRepaid: bigint;
  bidsPlaced: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Totals per pay token. */
  tokens: { token: Address; receivedNet: bigint; feesPaid: bigint; paidAsBuyer: bigint; escrowLive: bigint }[];
  borrowPositions: { marketId: Hex; borrowShares: bigint; collateral: bigint }[];
}

// ---------- Parsers ----------

type Row = Record<string, unknown>;

const shown = (value: unknown): string => JSON.stringify(value) ?? String(value);

function row(value: unknown): Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`expected an object, got ${shown(value)}`);
  }
  return value as Row;
}

function rows(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new TypeError(`expected a list, got ${shown(value)}`);
  return value.map(row);
}

/** BigInt columns arrive as JSON strings or JSON numbers; a number above 2^53 has already lost precision. */
function big(value: unknown): bigint {
  // BigInt(number) also takes integers that print in exponent form (1e21 and above).
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  throw new TypeError(`expected an integer amount, got ${shown(value)}`);
}

function int(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new TypeError(`expected an integer, got ${shown(value)}`);
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new TypeError(`expected a boolean, got ${shown(value)}`);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  throw new TypeError(`expected a string, got ${shown(value)}`);
}

/** Checksummed, like addresses decoded from logs. */
function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new TypeError(`expected an address, got ${shown(value)}`);
  }
  return getAddress(value);
}

function hex(value: unknown): Hex {
  if (typeof value === "string" && isHex(value)) return value;
  throw new TypeError(`expected hex data, got ${shown(value)}`);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T {
  const found = values.find((v) => v === value);
  if (found === undefined) throw new TypeError(`expected one of ${values.join(", ")}, got ${shown(value)}`);
  return found;
}

const absent = (value: unknown): boolean => value === null || value === undefined;
const optBig = (value: unknown): bigint | null => (absent(value) ? null : big(value));
const optInt = (value: unknown): number | null => (absent(value) ? null : int(value));
const optAddress = (value: unknown): Address | null => (absent(value) ? null : address(value));
/** `{ id }` of a related entity. */
const idOf = (value: unknown): Address => address(row(value).id);

function parseStatus(meta: Row, market: unknown): IndexStatus {
  return {
    chainId: int(meta.chainId),
    progressBlock: int(meta.progressBlock),
    sourceBlock: optInt(meta.sourceBlock),
    isReady: bool(meta.isReady),
    readyAt: absent(meta.readyAt) ? null : str(meta.readyAt),
    marketIndexed: !absent(market),
  };
}

function parseFill(r: Row): IndexedFill {
  return {
    kind: oneOf(FILL_KINDS, r.kind),
    sessionId: big(r.sessionId),
    bidId: optBig(r.bidId),
    seller: idOf(r.seller),
    buyer: idOf(r.buyer),
    buyerIsSelioVault: bool(r.buyerIsSelioVault),
    assets: big(r.assets),
    paid: big(r.paid),
    fee: big(r.fee),
    sellerNet: big(r.sellerNet),
    payToken: address(r.payToken),
    discountBps: int(r.discountBps),
    debtRepaid: optBig(r.debtRepaid),
    timestamp: int(r.timestamp),
    blockNumber: int(r.blockNumber),
    logIndex: int(r.logIndex),
    txHash: hex(r.txHash),
    txFrom: address(r.txFrom),
  };
}

function parseSession(r: Row): IndexedSession {
  return {
    sessionId: big(r.sessionId),
    seller: idOf(r.seller),
    startedAt: int(r.startedAt),
    endsAt: int(r.endsAt),
    startBps: int(r.startBps),
    stepBps: int(r.stepBps),
    stepInterval: int(r.stepInterval),
    capBps: int(r.capBps),
    openedAssets: big(r.openedAssets),
    soldAssets: big(r.soldAssets),
    withdrawnAssets: big(r.withdrawnAssets),
    listedAssets: big(r.listedAssets),
    fillCount: int(r.fillCount),
    avgDiscountBps: optInt(r.avgDiscountBps),
    fills: rows(r.fills).map((f) => ({
      timestamp: int(f.timestamp),
      discountBps: int(f.discountBps),
      assets: big(f.assets),
      kind: oneOf(FILL_KINDS, f.kind),
    })),
  };
}

function parseBid(r: Row): IndexedBid {
  return {
    bidId: big(r.bidId),
    bidder: idOf(r.bidder),
    isSelioVault: bool(r.isSelioVault),
    minDiscountBps: int(r.minDiscountBps),
    payToken: address(r.payToken),
    maxAssetsPlaced: big(r.maxAssetsPlaced),
    escrowPlaced: big(r.escrowPlaced),
    maxAssets: big(r.maxAssets),
    escrow: big(r.escrow),
    filledAssets: big(r.filledAssets),
    paidOut: big(r.paidOut),
    status: oneOf(BID_STATUSES, r.status),
    placedAt: int(r.placedAt),
    closedAt: optInt(r.closedAt),
  };
}

function parseCapacityPoint(r: Row): IndexedCapacityPoint {
  return {
    interval: oneOf(INTERVALS, r.interval),
    start: int(r.start),
    updatedAt: int(r.updatedAt),
    blockNumber: int(r.blockNumber),
    withdrawable: big(r.withdrawable),
    supplied: big(r.supplied),
    utilizationBps: int(r.utilizationBps),
    debtorCapacity: big(r.debtorCapacity),
    sessionAssets: big(r.sessionAssets),
    bidAt100: big(r.bidAt100),
    bidAt300: big(r.bidAt300),
    bidAt500: big(r.bidAt500),
    bidAt1000: big(r.bidAt1000),
    bidAt2000: big(r.bidAt2000),
    bidCapacityExact: bool(r.bidCapacityExact),
  };
}

function parseFeeTotal(r: Row): IndexedFeeTotal {
  return {
    payToken: address(r.payToken),
    fees: big(r.fees),
    gross: big(r.gross),
    sellerNet: big(r.sellerNet),
    fillCount: int(r.fillCount),
  };
}

function parseVaultState(r: Row): IndexedVaultState {
  const liveBid = absent(r.liveBid) ? null : row(r.liveBid);
  return {
    asset: address(r.asset),
    totalSupply: big(r.totalSupply),
    totalAssets: big(r.totalAssets),
    idle: big(r.idle),
    assetsPerShare: big(r.assetsPerShare),
    depositedAssets: big(r.depositedAssets),
    redeemedAssets: big(r.redeemedAssets),
    redeemedReceiptUnits: big(r.redeemedReceiptUnits),
    boughtAssets: big(r.boughtAssets),
    boughtCost: big(r.boughtCost),
    boughtFills: int(r.boughtFills),
    recoveredAssets: big(r.recoveredAssets),
    recoveryRateBps: optInt(r.recoveryRateBps),
    costRecoveryBps: optInt(r.costRecoveryBps),
    deferredUnits: big(r.deferredUnits),
    claimedUnits: big(r.claimedUnits),
    sourceShares: big(r.sourceShares),
    sourceDepositedAssets: big(r.sourceDepositedAssets),
    sourceWithdrawnAssets: big(r.sourceWithdrawnAssets),
    sourcePulledAssets: big(r.sourcePulledAssets),
    sourceSharesInKind: big(r.sourceSharesInKind),
    lastPullUtilizationBps: optInt(r.lastPullUtilizationBps),
    liveBid: liveBid === null ? null : { bidId: big(liveBid.bidId), capacityAssets: big(liveBid.capacityAssets) },
    updatedAt: int(r.updatedAt),
  };
}

function parseVaultPoint(r: Row): IndexedVaultPoint {
  return {
    interval: oneOf(INTERVALS, r.interval),
    start: int(r.start),
    totalAssets: big(r.totalAssets),
    idle: big(r.idle),
    totalSupply: big(r.totalSupply),
    assetsPerShare: big(r.assetsPerShare),
    depositedAssets: big(r.depositedAssets),
    redeemedAssets: big(r.redeemedAssets),
    recoveredAssets: big(r.recoveredAssets),
    boughtAssets: big(r.boughtAssets),
    boughtCost: big(r.boughtCost),
    sourceShares: big(r.sourceShares),
  };
}

function parseVaultAction(r: Row): IndexedVaultAction {
  return {
    kind: oneOf(VAULT_ACTION_KINDS, r.kind),
    account: idOf(r.account),
    receiver: optAddress(r.receiver),
    assets: optBig(r.assets),
    shares: optBig(r.shares),
    receiptUnits: optBig(r.receiptUnits),
    utilizationBps: optInt(r.utilizationBps),
    timestamp: int(r.timestamp),
    blockNumber: int(r.blockNumber),
    logIndex: int(r.logIndex),
    txHash: hex(r.txHash),
  };
}

function parseAccount(r: Row): IndexedAccount {
  return {
    receiptShares: big(r.receiptShares),
    vaultShares: big(r.vaultShares),
    sessionsOpened: int(r.sessionsOpened),
    soldAssets: big(r.soldAssets),
    boughtAssets: big(r.boughtAssets),
    debtRepaid: big(r.debtRepaid),
    bidsPlaced: int(r.bidsPlaced),
    firstSeenAt: int(r.firstSeenAt),
    lastSeenAt: int(r.lastSeenAt),
    tokens: rows(r.tokens).map((t) => ({
      token: address(t.token),
      receivedNet: big(t.receivedNet),
      feesPaid: big(t.feesPaid),
      paidAsBuyer: big(t.paidAsBuyer),
      escrowLive: big(t.escrowLive),
    })),
    borrowPositions: rows(r.borrowPositions).map((p) => ({
      marketId: hex(p.marketId),
      borrowShares: big(p.borrowShares),
      collateral: big(p.collateral),
    })),
  };
}

// ---------- Documents ----------

const FILL_FIELDS =
  "kind sessionId bidId seller { id } buyer { id } buyerIsSelioVault assets paid fee sellerNet payToken discountBps debtRepaid timestamp blockNumber logIndex txHash txFrom";
const SESSION_FIELDS =
  "sessionId seller { id } startedAt endsAt startBps stepBps stepInterval capBps openedAssets soldAssets withdrawnAssets listedAssets fillCount avgDiscountBps fills(order_by: [{blockNumber: asc}, {logIndex: asc}]) { timestamp discountBps assets kind }";
const BID_FIELDS =
  "bidId bidder { id } isSelioVault maxAssetsPlaced escrowPlaced maxAssets escrow filledAssets paidOut status placedAt closedAt payToken minDiscountBps";
const CAPACITY_FIELDS =
  "interval start updatedAt blockNumber withdrawable supplied utilizationBps debtorCapacity sessionAssets bidAt100 bidAt300 bidAt500 bidAt1000 bidAt2000 bidCapacityExact";
const VAULT_STATE_FIELDS =
  "asset totalSupply totalAssets idle assetsPerShare depositedAssets redeemedAssets redeemedReceiptUnits boughtAssets boughtCost boughtFills recoveredAssets recoveryRateBps costRecoveryBps deferredUnits claimedUnits sourceShares sourceDepositedAssets sourceWithdrawnAssets sourcePulledAssets sourceSharesInKind lastPullUtilizationBps updatedAt liveBid { bidId capacityAssets }";
const VAULT_POINT_FIELDS =
  "interval start totalAssets idle totalSupply assetsPerShare depositedAssets redeemedAssets recoveredAssets boughtAssets boughtCost sourceShares";
const VAULT_ACTION_FIELDS =
  "kind account { id } receiver assets shares receiptUnits utilizationBps timestamp blockNumber logIndex txHash";
const ACCOUNT_FIELDS =
  "receiptShares vaultShares sessionsOpened soldAssets boughtAssets debtRepaid bidsPlaced firstSeenAt lastSeenAt tokens { token receivedNet feesPaid paidAsBuyer escrowLive } borrowPositions { marketId borrowShares collateral }";

type Variables = Record<string, string | number>;

const lower = (a: Address): string => a.toLowerCase();

/** Enum values are written into the document, so only the two known ones pass. */
function intervalOf(value: IndexedInterval): IndexedInterval {
  return oneOf(INTERVALS, value);
}

/**
 * Reads the Selio event index. Every request also returns the index's progress on the chain and whether it knows
 * the market, in one round trip.
 */
export class IndexerClient {
  readonly url: string;
  readonly chainId: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: { url: string; chainId?: number; timeoutMs?: number; fetch?: typeof fetch }) {
    this.url = opts.url;
    this.chainId = opts.chainId ?? NETWORKS["monad-testnet"].chain.id;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch;
  }

  status(market: Address): Promise<IndexStatus> {
    return this.query("IndexStatus", [], "", { market: lower(market) }, () => ({})).then((r) => r.status);
  }

  /** A seller's auctions and fills, newest first. */
  sellerHistory(
    market: Address,
    seller: Address,
  ): Promise<{ status: IndexStatus; sessions: { sessionId: bigint; openedAssets: bigint }[]; fills: IndexedFill[] }> {
    return this.query(
      "SellerHistory",
      ["$seller: String!"],
      `sessions: Session(where: {market_id: {_eq: $market}, seller_id: {_eq: $seller}}, order_by: {startedAt: desc}, limit: ${SELLER_SESSIONS_LIMIT}) { sessionId openedAssets }
  fills: Fill(where: {market_id: {_eq: $market}, seller_id: {_eq: $seller}}, order_by: [{blockNumber: desc}, {logIndex: desc}], limit: ${SELLER_FILLS_LIMIT}) { ${FILL_FIELDS} }`,
      { market: lower(market), seller: lower(seller) },
      (data) => ({
        sessions: rows(data.sessions).map((s) => ({ sessionId: big(s.sessionId), openedAssets: big(s.openedAssets) })),
        fills: rows(data.fills).map(parseFill),
      }),
    );
  }

  /** One bidder's bids, newest first; every bid of the market when `bidder` is omitted. */
  bidderHistory(market: Address, bidder?: Address): Promise<{ status: IndexStatus; bids: IndexedBid[] }> {
    const byBidder = bidder !== undefined;
    return this.query(
      "BidderHistory",
      byBidder ? ["$bidder: String!"] : [],
      `bids: Bid(where: {market_id: {_eq: $market}${byBidder ? ", bidder_id: {_eq: $bidder}" : ""}}, order_by: [{placedAt: desc}, {bidId: desc}], limit: ${BIDDER_BIDS_LIMIT}) { ${BID_FIELDS} }`,
      { market: lower(market), ...(bidder !== undefined ? { bidder: lower(bidder) } : {}) },
      (data) => ({ bids: rows(data.bids).map(parseBid) }),
    );
  }

  /**
   * Capacity points of the buckets from `since` on, oldest first, and `seed`, the last point before `since`. Points
   * exist only for buckets with events: forward-fill them (`forwardFill`).
   */
  async capacity(
    market: Address,
    opts: { interval: IndexedInterval; since: number; limit?: number },
  ): Promise<{ status: IndexStatus; seed: IndexedCapacityPoint | null; points: IndexedCapacityPoint[] }> {
    const interval = intervalOf(opts.interval);
    return this.query(
      "CapacityHistory",
      ["$since: Int!", "$limit: Int!"],
      `points: CapacityPoint(where: {market_id: {_eq: $market}, interval: {_eq: "${interval}"}, start: {_gte: $since}}, order_by: {start: asc}, limit: $limit) { ${CAPACITY_FIELDS} }
  seed: CapacityPoint(where: {market_id: {_eq: $market}, interval: {_eq: "${interval}"}, start: {_lt: $since}}, order_by: {start: desc}, limit: 1) { ${CAPACITY_FIELDS} }`,
      { market: lower(market), since: opts.since, limit: opts.limit ?? CAPACITY_POINTS_LIMIT },
      (data) => ({
        seed: rows(data.seed).map(parseCapacityPoint)[0] ?? null,
        points: rows(data.points).map(parseCapacityPoint),
      }),
    );
  }

  /** Auctions opened since `since` (default: all), newest first, with their fills; optionally one seller's. */
  auctions(
    market: Address,
    opts: { since?: number; seller?: Address; limit: number; offset?: number },
  ): Promise<{ status: IndexStatus; sessions: IndexedSession[] }> {
    const bySeller = opts.seller !== undefined;
    return this.query(
      "Auctions",
      ["$since: Int!", "$limit: Int!", "$offset: Int!", ...(bySeller ? ["$seller: String!"] : [])],
      `sessions: Session(where: {market_id: {_eq: $market}, startedAt: {_gte: $since}${bySeller ? ", seller_id: {_eq: $seller}" : ""}}, order_by: [{startedAt: desc}, {sessionId: desc}], limit: $limit, offset: $offset) { ${SESSION_FIELDS} }`,
      {
        market: lower(market),
        since: opts.since ?? 0,
        limit: opts.limit,
        offset: opts.offset ?? 0,
        ...(opts.seller !== undefined ? { seller: lower(opts.seller) } : {}),
      },
      (data) => ({ sessions: rows(data.sessions).map(parseSession) }),
    );
  }

  /** Fills since `since` (default: all), newest first, optionally where `account` sold or bought; and fee totals. */
  fills(
    market: Address,
    opts: { since?: number; account?: Address; limit: number; offset?: number },
  ): Promise<{ status: IndexStatus; fills: IndexedFill[]; fees: IndexedFeeTotal[] }> {
    const byAccount = opts.account !== undefined;
    return this.query(
      "Fills",
      ["$since: Int!", "$limit: Int!", "$offset: Int!", ...(byAccount ? ["$account: String!"] : [])],
      `fills: Fill(where: {market_id: {_eq: $market}, timestamp: {_gte: $since}${byAccount ? ", _or: [{seller_id: {_eq: $account}}, {buyer_id: {_eq: $account}}]" : ""}}, order_by: [{blockNumber: desc}, {logIndex: desc}], limit: $limit, offset: $offset) { ${FILL_FIELDS} }
  fees: FeeTotal(where: {market_id: {_eq: $market}}) { payToken fees gross sellerNet fillCount }`,
      {
        market: lower(market),
        since: opts.since ?? 0,
        limit: opts.limit,
        offset: opts.offset ?? 0,
        ...(opts.account !== undefined ? { account: lower(opts.account) } : {}),
      },
      (data) => ({ fills: rows(data.fills).map(parseFill), fees: rows(data.fees).map(parseFeeTotal) }),
    );
  }

  /** The Selio Vault's state (null before its first event), its points since `since` and its latest actions. */
  async vault(
    market: Address,
    vault: Address,
    opts: { interval: IndexedInterval; since: number },
  ): Promise<{
    status: IndexStatus;
    state: IndexedVaultState | null;
    points: IndexedVaultPoint[];
    actions: IndexedVaultAction[];
  }> {
    const interval = intervalOf(opts.interval);
    return this.query(
      "Vault",
      ["$vault: String!", "$since: Int!"],
      `state: SelioVaultState_by_pk(id: $vault) { ${VAULT_STATE_FIELDS} }
  points: VaultInterval(where: {vault_id: {_eq: $vault}, interval: {_eq: "${interval}"}, start: {_gte: $since}}, order_by: {start: asc}) { ${VAULT_POINT_FIELDS} }
  actions: VaultAction(where: {vault_id: {_eq: $vault}}, order_by: [{blockNumber: desc}, {logIndex: desc}], limit: ${VAULT_ACTIONS_LIMIT}) { ${VAULT_ACTION_FIELDS} }`,
      { market: lower(market), vault: lower(vault), since: opts.since },
      (data) => ({
        state: absent(data.state) ? null : parseVaultState(row(data.state)),
        points: rows(data.points).map(parseVaultPoint),
        actions: rows(data.actions).map(parseVaultAction),
      }),
    );
  }

  /** A wallet's positions and totals; null for an address the index has never seen. */
  wallet(market: Address, account: Address): Promise<{ status: IndexStatus; account: IndexedAccount | null }> {
    return this.query(
      "Wallet",
      ["$account: String!"],
      `account: Account_by_pk(id: $account) { ${ACCOUNT_FIELDS} }`,
      { market: lower(market), account: lower(account) },
      (data) => ({ account: absent(data.account) ? null : parseAccount(row(data.account)) }),
    );
  }

  /** Sends one document; its common head reads `_meta` for the chain and `Market_by_pk` for `$market`. */
  private async query<T extends object>(
    name: string,
    params: string[],
    body: string,
    variables: Variables,
    parse: (data: Row) => T,
  ): Promise<{ status: IndexStatus } & T> {
    const document = `query ${name}(${["$market: String!", ...params].join(", ")}) {
  _meta(where: {chainId: {_eq: ${this.chainId}}}) { chainId progressBlock sourceBlock isReady readyAt }
  market: Market_by_pk(id: $market) { id updatedAt }
  ${body}
}`;
    const answer = await this.post(JSON.stringify({ query: document, variables }));
    if (answer.status < 200 || answer.status > 299) {
      const message =
        answer.status === 429
          ? "The Selio indexer is rate-limiting requests; try again shortly."
          : `The Selio indexer answered HTTP ${answer.status}`;
      throw new IndexerError(message, false, answer.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(answer.text);
    } catch {
      throw new IndexerError("The Selio indexer answered with a body that is not JSON.", true, null);
    }
    try {
      const result = row(json);
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        const message = (result.errors[0] as { message?: unknown } | null)?.message;
        throw new IndexerError(
          typeof message === "string" ? message : "The Selio indexer answered with an error.",
          false,
          answer.status,
        );
      }
      const data = row(result.data);
      const meta = rows(data._meta)[0];
      if (meta === undefined) {
        throw new IndexerError(`The Selio indexer does not index chain ${this.chainId}.`, false, answer.status);
      }
      return { status: parseStatus(meta, data.market), ...parse(data) };
    } catch (err) {
      if (err instanceof IndexerError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new IndexerError(`The Selio indexer answered with unexpected data: ${detail}`, false, answer.status);
    }
  }

  /** POSTs the body and reads the answer within the timeout. */
  private async post(body: string): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Called unbound: a browser's fetch rejects any other `this`.
    const send = this.fetchImpl ?? fetch;
    try {
      const res = await send(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: controller.signal,
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new IndexerError(`The Selio indexer did not answer within ${this.timeoutMs} ms.`, true, null);
      }
      // Node's fetch reports "fetch failed" and keeps the reason (refused, DNS, TLS) as its cause.
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new IndexerError(`The Selio indexer could not be reached: ${detail}.`, true, null);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * For each bucket start in `starts`, the latest point at or before it (the `seed` before the first point), or null
 * before any point: points exist only for buckets with events, and each value holds until the next one.
 */
export function forwardFill<T extends { start: number }>(seed: T | null, points: T[], starts: number[]): (T | null)[] {
  const candidates = seed === null ? points : [seed, ...points];
  return starts.map((start) => {
    let latest: T | null = null;
    for (const point of candidates) {
      if (point.start <= start && (latest === null || point.start >= latest.start)) latest = point;
    }
    return latest;
  });
}
