import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import type { TokenInfo } from "@selio/sdk";
import { baseYieldRows, baseYieldRule, sourceInKindText, sourceIsTight, sourceState, yieldSourceOf } from "./base-yield";

const USDC: TokenInfo = { address: `0x${"1".padStart(40, "0")}` as Address, symbol: "USDC", decimals: 6 };
const USDT0: TokenInfo = { address: `0x${"2".padStart(40, "0")}` as Address, symbol: "USDT0", decimals: 6 };
const SOURCE = `0x${"3".padStart(40, "0")}` as Address;

const withSource = {
  yieldSource: SOURCE,
  sourceSymbol: "yUSDC",
  sourceAssets: 400_000_000_000n,
  sourceUtilizationBps: 4_210,
};
const withoutSource = { yieldSource: zeroAddress, sourceSymbol: "", sourceAssets: 0n, sourceUtilizationBps: 0 };

describe("base-yield panel", () => {
  it("keeps the idle-capital line for a vault without a source", () => {
    const source = yieldSourceOf(withoutSource);
    expect(source).toBeNull();
    expect(baseYieldRule(source, USDT0)).toBe(
      "none on this deployment: USDT0 waits idle in the vault, outside the pool it protects, so it is never frozen with it",
    );
    expect(baseYieldRows(source, USDT0)).toEqual([]);
  });

  it("shows the source, what is in it and its utilization", () => {
    const source = yieldSourceOf(withSource);
    expect(baseYieldRows(source, USDC)).toEqual([
      { label: "Base yield source", value: "yUSDC", testid: "vault-source" },
      { label: "In source", value: "400,000 USDC", testid: "vault-in-source" },
      { label: "Source utilization", value: "42.10%", testid: "vault-source-utilization" },
    ]);
  });

  it("states the 90% rule", () => {
    expect(baseYieldRule(yieldSourceOf(withSource), USDC)).toBe(
      "capital beyond the bid's escrow earns yield in yUSDC, outside the pool it protects, and is pulled back to cash when the source reaches 90% utilization",
    );
  });

  it("treats the source as tight from 90% utilization", () => {
    expect(sourceIsTight({ address: SOURCE, symbol: "yUSDC", assets: 0n, utilizationBps: 8_999 })).toBe(false);
    expect(sourceIsTight({ address: SOURCE, symbol: "yUSDC", assets: 0n, utilizationBps: 9_000 })).toBe(true);
  });

  it("says whether the waiting capital earns or was pulled back", () => {
    const at = (utilizationBps: number, assets: bigint) => sourceState({ address: SOURCE, symbol: "waMonUSDC", assets, utilizationBps });
    expect(at(4_210, 10n)).toEqual({ tone: "open", text: "Earning: source at 42.10%" });
    expect(at(9_287, 0n)).toEqual({ tone: "tight", text: "Pulled back: source at 92.87%" });
    expect(at(9_000, 10n)).toEqual({
      tone: "tight",
      text: "Source at 90.00%: no new deposits, and anyone can pull the rest back to cash",
    });
  });

  it("shows the in-kind source part of a redemption only when there is one", () => {
    const shares: TokenInfo = { address: SOURCE, symbol: "yUSDC", decimals: 18 };
    expect(sourceInKindText(0n, shares)).toBeNull();
    expect(sourceInKindText(25n * 10n ** 17n, shares)).toBe("2.5 yUSDC");
    expect(sourceInKindText(1n, null)).toBeNull();
  });
});
