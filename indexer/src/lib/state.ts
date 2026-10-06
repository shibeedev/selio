// Load-or-create helpers and the bucket writers of Part 10 §10.1 F.2. Handlers read every row they
// touch at the top (so the preload pass batches the reads), update copies, then set them.
import type {
  Account,
  AccountToken,
  EarnVaultState,
  EvmOnEventContext,
  FeeTotal,
  Market,
  MarketInterval,
  MorphoMarket,
  SelioVaultState,
} from "envio";
import { DEPLOYMENT } from "../deployment";
import { accountTokenId, bucketId, buckets, feeTotalId, type IntervalName } from "./ids";
import { addFee, assetsPerShare, avgDiscountBps, exitCapacity } from "./math";

type Context = EvmOnEventContext;
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The parts of an indexed event that row builders read. */
export interface LogEvent {
  block: { number: number; timestamp: number };
  logIndex: number;
  transaction: { hash: string };
}

export const isSelioVault = (address: string): boolean => address === DEPLOYMENT.selioVault;

/** Error of an event that refers to a row the index has never seen (G.6). */
export const missing = (entity: string, id: string): string =>
  `Selio indexer: ${entity} ${id} is missing; start_block must be the deployment block of this market.`;

interface Store<E> {
  get(id: string): Promise<E | undefined>;
  set(entity: E): void;
}

/** Loads each distinct row once, so two roles with the same id (a seller filling their own bid) share one row. */
async function loadRows<E extends { id: string }>(store: Store<E>, defaults: readonly E[]): Promise<Map<string, Mutable<E>>> {
  const unique = [...new Map(defaults.map((row) => [row.id, row])).values()];
  const found = await Promise.all(unique.map((row) => store.get(row.id)));
  return new Map(unique.map((row, i): [string, Mutable<E>] => [row.id, { ...(found[i] ?? row) }]));
}

export function saveRows<E>(store: Store<E>, rows: Map<string, Mutable<E>>): void {
  for (const row of rows.values()) store.set(row);
}

export function rowOf<E>(rows: Map<string, E>, id: string): E {
  const row = rows.get(id);
  if (row === undefined) throw new Error(`Selio indexer: row ${id} was not loaded.`);
  return row;
}

const newAccount = (id: string, timestamp: number): Account => ({
  id,
  receiptShares: 0n,
  vaultShares: 0n,
  sessionsOpened: 0,
  soldAssets: 0n,
  boughtAssets: 0n,
  debtRepaid: 0n,
  bidsPlaced: 0,
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
});

export async function loadAccounts(
  context: Context,
  ids: readonly string[],
  timestamp: number,
): Promise<Map<string, Mutable<Account>>> {
  const rows = await loadRows(context.Account, ids.map((id) => newAccount(id, timestamp)));
  for (const row of rows.values()) row.lastSeenAt = timestamp;
  return rows;
}

export const loadAccountTokens = (
  context: Context,
  keys: readonly (readonly [account: string, token: string])[],
): Promise<Map<string, Mutable<AccountToken>>> =>
  loadRows(
    context.AccountToken,
    keys.map(([account, token]) => ({
      id: accountTokenId(account, token),
      account_id: account,
      token,
      receivedNet: 0n,
      feesPaid: 0n,
      paidAsBuyer: 0n,
      escrowLive: 0n,
    })),
  );

export async function loadFeeTotal(context: Context, payToken: string): Promise<Mutable<FeeTotal>> {
  const id = feeTotalId(DEPLOYMENT.market, payToken);
  const row = await context.FeeTotal.get(id);
  return { ...(row ?? { id, market_id: DEPLOYMENT.market, payToken, fees: 0n, gross: 0n, sellerNet: 0n, fillCount: 0 }) };
}

const newMarket = (timestamp: number): Market => ({
  id: DEPLOYMENT.market,
  chainId: DEPLOYMENT.chainId,
  receipt: DEPLOYMENT.earnVault,
  underlying: DEPLOYMENT.underlying,
  selioVault: DEPLOYMENT.selioVault,
  sessionsOpened: 0,
  bidsPlaced: 0,
  liveBids: 0,
  inexactLiveBids: 0,
  fillCount: 0,
  filledAssets: 0n,
  borrowerFilledAssets: 0n,
  bidFilledAssets: 0n,
  debtRepaid: 0n,
  redeemedAssets: 0n,
  sessionAssets: 0n,
  bidAt100: 0n,
  bidAt300: 0n,
  bidAt500: 0n,
  bidAt1000: 0n,
  bidAt2000: 0n,
  updatedAt: timestamp,
});

export async function loadMarket(context: Context, timestamp: number): Promise<Mutable<Market>> {
  return { ...(await context.Market.getOrCreate(newMarket(timestamp))) };
}

const newMarketInterval = (interval: IntervalName, start: number): MarketInterval => ({
  id: bucketId(DEPLOYMENT.market, interval, start),
  market_id: DEPLOYMENT.market,
  interval,
  start,
  fillCount: 0,
  filledAssets: 0n,
  borrowerFilledAssets: 0n,
  bidFilledAssets: 0n,
  debtRepaid: 0n,
  discountWeighted: 0n,
  avgDiscountBps: undefined,
  minDiscountBps: undefined,
  maxDiscountBps: undefined,
  feesByToken: {},
  sessionsOpened: 0,
  bidsPlaced: 0,
  redeemedAssets: 0n,
});

/** The market's HOUR and DAY activity rows for the event's time. */
export async function loadMarketIntervals(context: Context, timestamp: number): Promise<Mutable<MarketInterval>[]> {
  const defaults = buckets(timestamp).map(({ interval, start }) => newMarketInterval(interval, start));
  return [...(await loadRows(context.MarketInterval, defaults)).values()];
}

export interface IntervalDelta {
  fill?: { assets: bigint; discountBps: number; fee: bigint; payToken: string; debtRepaid?: bigint };
  sessionsOpened?: number;
  bidsPlaced?: number;
  redeemedAssets?: bigint;
}

/** Adds one event's activity to both bucket rows and writes them. A fill with `debtRepaid` is a borrower fill. */
export function bumpMarketInterval(context: Context, rows: Mutable<MarketInterval>[], delta: IntervalDelta): void {
  for (const row of rows) {
    const { fill } = delta;
    if (fill !== undefined) {
      row.fillCount += 1;
      row.filledAssets += fill.assets;
      if (fill.debtRepaid === undefined) {
        row.bidFilledAssets += fill.assets;
      } else {
        row.borrowerFilledAssets += fill.assets;
        row.debtRepaid += fill.debtRepaid;
      }
      row.discountWeighted += fill.assets * BigInt(fill.discountBps);
      row.avgDiscountBps = avgDiscountBps(row.discountWeighted, row.filledAssets);
      row.minDiscountBps = Math.min(row.minDiscountBps ?? fill.discountBps, fill.discountBps);
      row.maxDiscountBps = Math.max(row.maxDiscountBps ?? fill.discountBps, fill.discountBps);
      row.feesByToken = addFee(row.feesByToken as Record<string, string>, fill.payToken, fill.fee);
    }
    row.sessionsOpened += delta.sessionsOpened ?? 0;
    row.bidsPlaced += delta.bidsPlaced ?? 0;
    row.redeemedAssets += delta.redeemedAssets ?? 0n;
    context.MarketInterval.set(row);
  }
}

/** The Earn vault and the two tracked Morpho markets, which exit capacity is computed from (E.8). */
export interface Pool {
  earnVault: Mutable<EarnVaultState>;
  /** The earn and flash markets, by market id. */
  morphoMarkets: Map<string, Mutable<MorphoMarket>>;
}

const newMorphoMarket = (id: string, timestamp: number): MorphoMarket => ({
  id,
  role: id === DEPLOYMENT.earnMarketId ? "EARN" : "FLASH",
  totalSupplyAssets: 0n,
  totalSupplyShares: 0n,
  totalBorrowAssets: 0n,
  totalBorrowShares: 0n,
  adapterSupplyShares: 0n,
  updatedAt: timestamp,
});

/** Reads the pool rows without creating them; handlers that change one set it themselves. */
export async function loadPool(context: Context, timestamp: number): Promise<Pool> {
  const marketIds = [DEPLOYMENT.earnMarketId, DEPLOYMENT.flashMarketId];
  const [earnVault, ...markets] = await Promise.all([
    context.EarnVaultState.get(DEPLOYMENT.earnVault),
    ...marketIds.map((id) => context.MorphoMarket.get(id)),
  ]);
  return {
    earnVault: {
      ...(earnVault ?? {
        id: DEPLOYMENT.earnVault,
        idle: 0n,
        totalAssets: 0n,
        totalSupply: 0n,
        depositedAssets: 0n,
        withdrawnAssets: 0n,
        penaltyAssets: 0n,
        updatedAt: timestamp,
      }),
    },
    morphoMarkets: new Map(
      marketIds.map((id, i): [string, Mutable<MorphoMarket>] => [id, { ...(markets[i] ?? newMorphoMarket(id, timestamp)) }]),
    ),
  };
}

/** E.8: upserts the HOUR and DAY capacity points with the state after the event. */
export function writeCapacity(context: Context, event: LogEvent, market: Market, pool: Pool): void {
  const capacity = exitCapacity(pool.earnVault, [...pool.morphoMarkets.values()]);
  for (const { interval, start } of buckets(event.block.timestamp)) {
    context.CapacityPoint.set({
      id: bucketId(market.id, interval, start),
      market_id: market.id,
      interval,
      start,
      updatedAt: event.block.timestamp,
      blockNumber: event.block.number,
      withdrawable: capacity.withdrawable,
      supplied: capacity.supplied,
      utilizationBps: capacity.utilizationBps,
      debtorCapacity: capacity.debtorCapacity,
      sessionAssets: market.sessionAssets,
      bidAt100: market.bidAt100,
      bidAt300: market.bidAt300,
      bidAt500: market.bidAt500,
      bidAt1000: market.bidAt1000,
      bidAt2000: market.bidAt2000,
      bidCapacityExact: market.inexactLiveBids === 0,
    });
  }
}

export async function loadVault(context: Context, timestamp: number): Promise<Mutable<SelioVaultState>> {
  const row = await context.SelioVaultState.get(DEPLOYMENT.selioVault);
  return {
    ...(row ?? {
      id: DEPLOYMENT.selioVault,
      market_id: DEPLOYMENT.market,
      asset: DEPLOYMENT.underlying,
      totalSupply: 0n,
      totalAssets: 0n,
      idle: 0n,
      assetsPerShare: assetsPerShare(0n, 0n),
      depositedAssets: 0n,
      redeemedAssets: 0n,
      redeemedReceiptUnits: 0n,
      boughtAssets: 0n,
      boughtCost: 0n,
      boughtFills: 0,
      recoveredAssets: 0n,
      recoveryRateBps: undefined,
      costRecoveryBps: undefined,
      deferredUnits: 0n,
      claimedUnits: 0n,
      sourceShares: 0n,
      sourceDepositedAssets: 0n,
      sourceWithdrawnAssets: 0n,
      sourcePulledAssets: 0n,
      sourceSharesInKind: 0n,
      lastPullUtilizationBps: undefined,
      liveBid_id: undefined,
      updatedAt: timestamp,
    }),
  };
}

/** Upserts the vault's HOUR and DAY rows with its state after the event. */
export function bumpVaultInterval(context: Context, vault: SelioVaultState, timestamp: number): void {
  for (const { interval, start } of buckets(timestamp)) {
    context.VaultInterval.set({
      id: bucketId(vault.id, interval, start),
      vault_id: vault.id,
      interval,
      start,
      totalAssets: vault.totalAssets,
      idle: vault.idle,
      totalSupply: vault.totalSupply,
      assetsPerShare: vault.assetsPerShare,
      depositedAssets: vault.depositedAssets,
      redeemedAssets: vault.redeemedAssets,
      recoveredAssets: vault.recoveredAssets,
      boughtAssets: vault.boughtAssets,
      boughtCost: vault.boughtCost,
      sourceShares: vault.sourceShares,
    });
  }
}
