import { describe, expect, it } from "vitest";
import { bucketId, buckets, dayStart, hourStart, logId } from "./ids";
import {
  addFee,
  assetsPerShare,
  avgDiscountBps,
  bidCapacity,
  clampSub,
  exitCapacity,
  ratioBps,
  sellerNet,
  shiftDepth,
  toAssetsDown,
  utilizationBps,
} from "./math";

describe("ids and buckets (E.1)", () => {
  it("puts a timestamp in its UTC hour and day", () => {
    expect(hourStart(1_791_872_663)).toBe(1_791_871_200);
    expect(dayStart(1_791_872_663)).toBe(1_791_849_600);
    expect(buckets(1_791_872_663)).toEqual([
      { interval: "HOUR", start: 1_791_871_200 },
      { interval: "DAY", start: 1_791_849_600 },
    ]);
  });

  it("builds log and bucket ids", () => {
    expect(logId(70_610_212, 3)).toBe("70610212-3");
    expect(bucketId("0xabc", "DAY", 1_791_849_600)).toBe("0xabc-DAY-1791849600");
  });
});

describe("bid capacity and depth (E.2, E.3)", () => {
  it("sizes a same-asset bid by its escrow at its own discount", () => {
    const bid = { maxAssets: 1_200_000_000n, escrow: 950_000_000n, minDiscountBps: 500, payIsUnderlying: true };
    expect(bidCapacity(bid)).toBe(1_000_000_000n);
    expect(bidCapacity({ ...bid, maxAssets: 900_000_000n })).toBe(900_000_000n);
  });

  it("counts a bid in another pay token at its remaining size", () => {
    expect(bidCapacity({ maxAssets: 1_200_000_000n, escrow: 1n, minDiscountBps: 500, payIsUnderlying: false })).toBe(
      1_200_000_000n,
    );
  });

  it("adds capacity only to levels at or above the bid's minimum discount", () => {
    const zero = { bidAt100: 0n, bidAt300: 0n, bidAt500: 0n, bidAt1000: 0n, bidAt2000: 0n };
    expect(shiftDepth(zero, 500, 7n)).toEqual({ bidAt100: 0n, bidAt300: 0n, bidAt500: 7n, bidAt1000: 7n, bidAt2000: 7n });
    expect(shiftDepth(shiftDepth(zero, 100, 5n), 100, -5n)).toEqual(zero);
  });
});

describe("fills (E.5)", () => {
  it("pays the seller the payment minus the fee", () => {
    const paid = 1_000_000_000n;
    const fee = (paid * 20n) / 10_000n;
    expect(fee).toBe(2_000_000n);
    expect(sellerNet(paid, fee)).toBe(998_000_000n);
  });

  it("weights the average discount by receipt value", () => {
    // 100 at 5% and 300 at 3%: (100 × 500 + 300 × 300) / 400 = 350
    expect(avgDiscountBps(100n * 500n + 300n * 300n, 400n)).toBe(350);
    expect(avgDiscountBps(0n, 0n)).toBeUndefined();
  });

  it("sums fees per pay token as decimal strings", () => {
    const once = addFee({}, "0xusdc", 2_000_000n);
    expect(addFee(once, "0xusdc", 500n)).toEqual({ "0xusdc": "2000500" });
    expect(addFee(once, "0xausd", 7n)).toEqual({ "0xusdc": "2000000", "0xausd": "7" });
  });
});

describe("pool and capacity (E.7, E.8)", () => {
  it("converts Morpho supply shares to assets rounding down", () => {
    expect(toAssetsDown(10n ** 12n, 10n ** 9n, 10n ** 15n)).toBe(1_000_000n);
  });

  it("rounds utilization down and is 0 with nothing supplied", () => {
    expect(utilizationBps(1n, 3n)).toBe(6666);
    expect(utilizationBps(0n, 0n)).toBe(0);
    expect(utilizationBps(5n, 3n)).toBe(0);
  });

  it("counts idle cash and what each supplied market can pay", () => {
    const earn = {
      totalSupplyAssets: 980_000_000n,
      totalSupplyShares: 10n ** 15n,
      totalBorrowAssets: 630_000_000n,
      adapterSupplyShares: 10n ** 15n,
    };
    const unsupplied = { totalSupplyAssets: 50n, totalSupplyShares: 50n, totalBorrowAssets: 7n, adapterSupplyShares: 0n };
    // The adapter's 980 USDC position is capped by the market's 350 USDC of free liquidity.
    expect(exitCapacity({ idle: 25n, totalAssets: 1_000_000_000n }, [earn, unsupplied])).toEqual({
      withdrawable: 350_000_025n,
      supplied: 1_000_000_000n,
      utilizationBps: 6499,
      debtorCapacity: 630_000_000n,
    });
  });

  it("floors subtraction at 0", () => {
    expect(clampSub(5n, 7n)).toBe(0n);
    expect(clampSub(7n, 5n)).toBe(2n);
  });
});

describe("Selio Vault figures (E.10)", () => {
  it("rates recoveries in bps and leaves them null before any purchase", () => {
    expect(ratioBps(1_000_000_000n, 970_000_000n)).toBe(10_309);
    expect(ratioBps(1n, 0n)).toBeUndefined();
  });

  it("values a share as previewDeposit prices it", () => {
    expect(assetsPerShare(0n, 0n)).toBe(1_000_000n);
    expect(assetsPerShare(2_000_000_000n, 1_000_000_000_000n)).toBe(1_999_999n);
  });
});
