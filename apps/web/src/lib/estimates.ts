const BPS = 10_000n;
const WAD = 10n ** 18n;
const MAX_UINT = 2n ** 256n - 1n;

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export interface AaveRepayEstimate {
  ok: boolean;
  reason: string | null;
  debtRepaid: bigint;
  flashFee: bigint;
  usesExternalFlash: boolean;
}

/** Mirrors AaveExitMarket._repayFor: which flash source is used, how many rounds, and the premium. */
export function estimateAaveRepay(p: {
  assets: bigint;
  aaveChunk: bigint;
  externalChunk: bigint;
  premiumBps: bigint;
  maxLoops: bigint;
}): AaveRepayEstimate {
  const a = min(p.aaveChunk, p.assets);
  const e = min(p.externalChunk, p.assets);
  const usesExternalFlash = e > 0n && e >= a;
  const chunk = usesExternalFlash ? e : a;
  const fail = (reason: string): AaveRepayEstimate => ({ ok: false, reason, debtRepaid: 0n, flashFee: 0n, usesExternalFlash });
  if (p.assets === 0n) return fail("Enter an amount");
  if (chunk === 0n) return fail("No flash liquidity is available to repay on your behalf right now");
  if ((p.assets + chunk - 1n) / chunk > p.maxLoops) {
    return fail("The pool has too little flash liquidity for this size; try a smaller amount");
  }
  // Aave's percentMul rounds half up; the premium is charged on one chunk, not on the whole purchase.
  const flashFee = usesExternalFlash ? 0n : (chunk * p.premiumBps + 5_000n) / BPS;
  if (flashFee >= p.assets) return fail("The flash fee would exceed the purchase");
  return { ok: true, reason: null, debtRepaid: p.assets - flashFee, flashFee, usesExternalFlash };
}

/** USD value with 8 decimals of `amount` priced at `price8`. */
export function valueInBase(amount: bigint, decimals: number, price8: bigint): bigint {
  return (amount * price8) / 10n ** BigInt(decimals);
}

/** Uses the account's average liquidation threshold, so it is an estimate. */
export function estimateAaveHealthAfter(p: {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint;
  collateralRemovedBase: bigint;
  collateralAddedBase?: bigint;
  debtRepaidBase: bigint;
}): bigint | null {
  const debt = p.totalDebtBase - p.debtRepaidBase;
  const collateral = p.totalCollateralBase - p.collateralRemovedBase + (p.collateralAddedBase ?? 0n);
  if (collateral < 0n) return null;
  if (debt <= 0n) return MAX_UINT;
  return (collateral * p.liquidationThresholdBps * WAD) / BPS / debt;
}

export function estimateMorphoHealthAfter(p: {
  health: bigint;
  debt: bigint;
  collateral: bigint;
  collateralRemoved: bigint;
  debtRepaid: bigint;
}): bigint | null {
  if (p.collateral === 0n || p.debt === 0n || p.collateralRemoved > p.collateral) return null;
  const debtAfter = p.debt - p.debtRepaid;
  if (debtAfter <= 0n) return MAX_UINT;
  const maxBorrow = (p.health * p.debt) / WAD;
  const maxBorrowAfter = (maxBorrow * (p.collateral - p.collateralRemoved)) / p.collateral;
  return (maxBorrowAfter * WAD) / debtAfter;
}

export function discountedValue(assets: bigint, discountBps: number): bigint {
  return (assets * (BPS - BigInt(discountBps))) / BPS;
}
