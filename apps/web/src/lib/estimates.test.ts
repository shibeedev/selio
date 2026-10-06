import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import { discountedValue, estimateAaveHealthAfter, estimateAaveRepay, estimateMorphoHealthAfter, valueInBase } from "./estimates";

const E18 = 10n ** 18n;
const terms = { premiumBps: 5n, maxLoops: 64n };

describe("estimateAaveRepay", () => {
  it("charges Aave's premium when the pool lends", () => {
    const r = estimateAaveRepay({ assets: 10n * E18, aaveChunk: 100n * E18, externalChunk: 0n, ...terms });
    expect(r.ok).toBe(true);
    expect(r.usesExternalFlash).toBe(false);
    expect(r.flashFee).toBe((10n * E18 * 5n) / 10_000n);
    expect(r.debtRepaid).toBe(10n * E18 - r.flashFee);
  });

  it("uses the free external lender when it lends at least as much", () => {
    const r = estimateAaveRepay({ assets: 10n * E18, aaveChunk: 10n * E18, externalChunk: 10n * E18, ...terms });
    expect(r.usesExternalFlash).toBe(true);
    expect(r.flashFee).toBe(0n);
    expect(r.debtRepaid).toBe(10n * E18);
  });

  it("charges the premium on one chunk when the purchase loops", () => {
    const r = estimateAaveRepay({ assets: 10n * E18, aaveChunk: 3n * E18, externalChunk: 0n, ...terms });
    expect(r.flashFee).toBe((3n * E18 * 5n + 5_000n) / 10_000n);
    expect(r.debtRepaid).toBe(10n * E18 - r.flashFee);
  });

  it("refuses without flash liquidity or beyond the round limit", () => {
    expect(estimateAaveRepay({ assets: 10n, aaveChunk: 0n, externalChunk: 0n, ...terms }).ok).toBe(false);
    const tooBig = estimateAaveRepay({ assets: 65n, aaveChunk: 1n, externalChunk: 0n, ...terms });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.reason).toMatch(/smaller amount/);
  });
});

describe("health estimates", () => {
  const account = { totalCollateralBase: 2_000n, totalDebtBase: 1_000n, liquidationThresholdBps: 8_000n };

  it("estimates Aave health and sees it rise after a flash purchase", () => {
    expect(estimateAaveHealthAfter({ ...account, collateralRemovedBase: 0n, debtRepaidBase: 0n })).toBe(1_600_000_000_000_000_000n);
    const after = estimateAaveHealthAfter({ ...account, collateralRemovedBase: 97n, debtRepaidBase: 100n });
    expect(after! > 1_600_000_000_000_000_000n).toBe(true);
  });

  it("reports no debt once all of it is repaid", () => {
    expect(estimateAaveHealthAfter({ ...account, collateralRemovedBase: 10n, debtRepaidBase: 1_000n })).toBe(maxUint256);
  });

  it("keeps Morpho health when collateral and debt halve together", () => {
    expect(estimateMorphoHealthAfter({ health: 2n * E18, debt: 100n, collateral: 50n, collateralRemoved: 25n, debtRepaid: 50n })).toBe(
      2n * E18,
    );
  });

  it("has no Morpho estimate without debt", () => {
    expect(estimateMorphoHealthAfter({ health: maxUint256, debt: 0n, collateral: 50n, collateralRemoved: 0n, debtRepaid: 0n })).toBeNull();
  });
});

describe("value helpers", () => {
  it("values amounts in USD base units and applies discounts", () => {
    expect(valueInBase(2n * E18, 18, 3_000n * 10n ** 8n)).toBe(6_000n * 10n ** 8n);
    expect(valueInBase(1_500_000n, 6, 10n ** 8n)).toBe(150_000_000n);
    expect(discountedValue(10_000n, 250)).toBe(9_750n);
  });
});
