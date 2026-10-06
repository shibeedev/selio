import { maxUint256 } from "viem";
import { describe, expect, it } from "vitest";
import {
  bpsToPercentInput,
  displayDecimals,
  formatAmount,
  formatDuration,
  formatHealth,
  formatShare,
  formatToken,
  parseAmountInput,
  parsePercentToBps,
  shortAddress,
  toInputString,
  utilizationTone,
} from "./format";

describe("formatAmount", () => {
  it("groups thousands and rounds to the display decimals", () => {
    expect(formatAmount(1_234_567_890n, 6)).toBe("1,234.57");
    expect(formatAmount(12_500_000n, 6)).toBe("12.5");
  });

  it("never shows a non-zero amount as zero", () => {
    expect(formatAmount(49_000_000_000_000n, 18)).toBe("< 0.0001");
  });

  it("formats zero and negative amounts", () => {
    expect(formatAmount(0n, 6)).toBe("0");
    expect(formatAmount(-1_500_000n, 6)).toBe("-1.5");
  });

  it("shows 4 decimals from 9-decimal tokens up, else 2", () => {
    expect(displayDecimals(18)).toBe(4);
    expect(displayDecimals(9)).toBe(4);
    expect(displayDecimals(6)).toBe(2);
  });

  it("adds the token symbol", () => {
    expect(formatToken(10n ** 18n, { decimals: 18, symbol: "WETH" })).toBe("1 WETH");
  });
});

describe("parseAmountInput", () => {
  it("parses plain, grouped and leading-dot numbers", () => {
    expect(parseAmountInput("1.5", 6).value).toBe(1_500_000n);
    expect(parseAmountInput("1,234.5", 6).value).toBe(1_234_500_000n);
    expect(parseAmountInput(".5", 6).value).toBe(500_000n);
  });

  it("treats blank input as neither a value nor an error", () => {
    expect(parseAmountInput("   ", 6)).toEqual({ value: null, error: null });
  });

  it("explains text that is not a number", () => {
    expect(parseAmountInput("abc", 6).error).toMatch(/number/);
  });

  it("refuses malformed and negative numbers", () => {
    expect(parseAmountInput("1.2.3", 6).value).toBeNull();
    expect(parseAmountInput("-1", 6).value).toBeNull();
  });

  it("refuses more decimals than the token has", () => {
    expect(parseAmountInput("1.1234567", 6).error).toBe("At most 6 decimals");
  });

  it("round-trips through the exact input text", () => {
    const value = 123_456_789n;
    expect(parseAmountInput(toInputString(value, 6), 6).value).toBe(value);
  });
});

describe("percent inputs", () => {
  it("parses percentages to basis points", () => {
    expect(parsePercentToBps("2.5")).toBe(250);
    expect(parsePercentToBps("3")).toBe(300);
    expect(parsePercentToBps("0.05")).toBe(5);
    expect(parsePercentToBps("95 %")).toBe(9_500);
  });

  it("rejects more than two decimals and non-numbers", () => {
    expect(parsePercentToBps("2.555")).toBeNull();
    expect(parsePercentToBps("x")).toBeNull();
    expect(parsePercentToBps("")).toBeNull();
  });

  it("writes basis points back as a percent input", () => {
    expect(bpsToPercentInput(200)).toBe("2.00");
  });
});

describe("other formats", () => {
  it("formats health factors", () => {
    expect(formatHealth(1_523_000_000_000_000_000n)).toBe("1.52");
    expect(formatHealth(maxUint256)).toBe("No debt");
    expect(formatHealth(2_000n * 10n ** 18n)).toBe("> 1,000");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(720)).toBe("12 m");
    expect(formatDuration(18_600)).toBe("5 h 10 m");
    expect(formatDuration(183_600)).toBe("2 d 3 h");
    expect(formatDuration(-5)).toBe("0 s");
  });

  it("shortens addresses, picks status tones and formats shares", () => {
    expect(shortAddress("0x7a4e0000000000000000000000000000ffff3c1e")).toBe("0x7a4e…3c1e");
    expect(utilizationTone(9_977)).toBe("frozen");
    expect(utilizationTone(9_170)).toBe("tight");
    expect(utilizationTone(8_449)).toBe("open");
    expect(formatShare(1n, 100n)).toBe("1.00%");
    expect(formatShare(1n, 0n)).toBe("0.00%");
  });
});
