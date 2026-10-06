// Pure functions of Part 10 §10.1 E.2 to E.10. Amounts are bigint base units; bps are numbers.

export const BPS = 10_000n;
/** Discount levels of the bid depth (bidAt100 … bidAt2000). */
export const LEVELS = [100, 300, 500, 1_000, 2_000] as const;

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
/** `a − b`, floored at 0. */
export const clampSub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);

/**
 * E.2: receipt value a bid can still buy at its own minimum discount. A bid paying in the underlying
 * is exact (the on-chain `bidCapacity`); another pay token counts at its full remaining `maxAssets`.
 */
export function bidCapacity(bid: {
  maxAssets: bigint;
  escrow: bigint;
  minDiscountBps: number;
  payIsUnderlying: boolean;
}): bigint {
  if (!bid.payIsUnderlying) return bid.maxAssets;
  return minBig(bid.maxAssets, (bid.escrow * BPS) / (BPS - BigInt(bid.minDiscountBps)));
}

/** Bid capacity of live bids with `minDiscountBps ≤ L`, for each level L. */
export type DepthLevels = Record<`bidAt${(typeof LEVELS)[number]}`, bigint>;

/** E.3: adds `delta` of capacity to every level at or above the bid's minimum discount. */
export function shiftDepth(depth: DepthLevels, minDiscountBps: number, delta: bigint): DepthLevels {
  const next = {} as DepthLevels;
  for (const level of LEVELS) {
    next[`bidAt${level}`] = depth[`bidAt${level}`] + (minDiscountBps <= level ? delta : 0n);
  }
  return next;
}

/** E.5: the fee comes out of the seller's side. */
export const sellerNet = (paid: bigint, fee: bigint): bigint => paid - fee;

/** E.5: value-weighted average discount, undefined (null) while nothing is filled. */
export const avgDiscountBps = (discountWeighted: bigint, filledAssets: bigint): number | undefined =>
  filledAssets === 0n ? undefined : Number(discountWeighted / filledAssets);

/** E.5: adds a fill's fee to a bucket's `feesByToken` (pay token → decimal string). */
export const addFee = (
  feesByToken: Readonly<Record<string, string>>,
  payToken: string,
  fee: bigint,
): Record<string, string> => ({
  ...feesByToken,
  [payToken]: (BigInt(feesByToken[payToken] ?? "0") + fee).toString(),
});

/** E.7: Morpho Blue `SharesMathLib.toAssetsDown` (virtual assets 1, virtual shares 1e6). */
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint): bigint =>
  (shares * (totalAssets + 1n)) / (totalShares + 1_000_000n);

export interface MorphoTotals {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  adapterSupplyShares: bigint;
}

/** E.7: what a Morpho market can pay out now. */
export const freeLiquidity = (m: MorphoTotals): bigint => clampSub(m.totalSupplyAssets, m.totalBorrowAssets);

/** E.8: share of supply that cannot be withdrawn now, rounded down; 0 when nothing is supplied. */
export const utilizationBps = (withdrawable: bigint, supplied: bigint): number =>
  supplied === 0n || withdrawable >= supplied ? 0 : Number(((supplied - withdrawable) * BPS) / supplied);

/** E.8: exit capacity of the Earn vault, from its idle cash and the markets its adapter supplies. */
export function exitCapacity(
  earnVault: { idle: bigint; totalAssets: bigint },
  markets: readonly MorphoTotals[],
): { withdrawable: bigint; supplied: bigint; utilizationBps: number; debtorCapacity: bigint } {
  let withdrawable = earnVault.idle;
  let debtorCapacity = 0n;
  for (const m of markets) {
    if (m.adapterSupplyShares === 0n) continue;
    withdrawable += minBig(toAssetsDown(m.adapterSupplyShares, m.totalSupplyAssets, m.totalSupplyShares), freeLiquidity(m));
    debtorCapacity += m.totalBorrowAssets;
  }
  const supplied = earnVault.totalAssets;
  return { withdrawable, supplied, utilizationBps: utilizationBps(withdrawable, supplied), debtorCapacity };
}

/** E.10: `numerator / denominator` in bps, rounded down; undefined (null) while the denominator is 0. */
export const ratioBps = (numerator: bigint, denominator: bigint): number | undefined =>
  denominator === 0n ? undefined : Number((numerator * BPS) / denominator);

/** E.10: asset base units per whole Selio Vault share (9 decimals), as `previewDeposit` prices it. */
export const assetsPerShare = (totalAssets: bigint, totalSupply: bigint): bigint =>
  ((totalAssets + 1n) * 1_000_000_000n) / (totalSupply + 1_000n);
