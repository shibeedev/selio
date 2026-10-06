import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { TokenInfo } from "@selio/sdk";
import { amountFor, auctionFeeRows, feeLabel, formatFillAmounts, formatPlanAmounts } from "./fees";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const USDC: TokenInfo = { address: a(1), symbol: "USDC", decimals: 6 };
const WETH: TokenInfo = { address: a(2), symbol: "WETH", decimals: 18 };
const tokens = [USDC, WETH];

describe("fee rows", () => {
  it("label the fee from the market's FEE_BPS", () => {
    expect(feeLabel(20)).toBe("Fee 0.2%");
    expect(feeLabel(25)).toBe("Fee 0.3%");
  });

  it("join a plan's amounts per pay token in plan order", () => {
    const sellerNet = { [a(2)]: 5n * 10n ** 17n, [a(1)]: 1_996_000_000n } as Record<Address, bigint>;
    expect(formatPlanAmounts(sellerNet, tokens, USDC)).toBe("0.5 WETH + 1,996 USDC");
  });

  it("show zero in the underlying when nothing fills, and raw amounts for unknown tokens", () => {
    expect(formatPlanAmounts({}, tokens, USDC)).toBe("0 USDC");
    expect(formatPlanAmounts({ [a(9)]: 42n } as Record<Address, bigint>, tokens, USDC)).toBe(`42 of ${a(9)}`);
  });

  it("find a token's amount whatever the letter case of the key", () => {
    const fees = { [a(10).replace("a", "A")]: 7n } as Record<Address, bigint>;
    expect(amountFor(fees, a(10))).toBe(7n);
    expect(amountFor(fees, a(11))).toBe(0n);
  });

  it("join the received amounts and fees of past fills", () => {
    expect(formatFillAmounts([{ token: a(1), amount: 998_000n }, { token: a(2), amount: 10n ** 18n }], tokens)).toBe("1 USDC + 1 WETH");
    expect(formatFillAmounts([], tokens)).toBe("0");
    expect(formatFillAmounts([{ token: a(9), amount: 5n }], tokens)).toBe("5");
  });

  it("show the auction's fee and net amount at the start discount and at the cap", () => {
    const atStart = { payment: 995_000_000n, fee: 1_990_000n, sellerNet: 993_010_000n };
    const atCap = { payment: 950_000_000n, fee: 1_900_000n, sellerNet: 948_100_000n };
    expect(auctionFeeRows(atStart, atCap, 50, 500, USDC)).toEqual({
      fee: "1.99 USDC at 0.50% off, 1.9 USDC at 5.00% off",
      receive: "993.01 USDC at 0.50% off, down to 948.1 USDC at 5.00% off",
    });
  });
});
