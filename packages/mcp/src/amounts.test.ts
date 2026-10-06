import { describe, expect, it } from "vitest";
import { amountView, bpsView, parseAmount, parsePositiveAmount } from "./amounts.js";
import { ToolError } from "./errors.js";

describe("parseAmount", () => {
  it("converts human decimal strings to base units", () => {
    expect(parseAmount("2.5", 18, "assets")).toBe(2_500_000_000_000_000_000n);
    expect(parseAmount("1000", 6, "assets")).toBe(1_000_000_000n);
    expect(parseAmount("0.000001", 6, "assets")).toBe(1n);
  });

  it("rejects more decimals than the token has", () => {
    expect(() => parseAmount("1.0000001", 6, "assets")).toThrow(/7 decimals but the token only has 6/);
  });

  it("rejects anything but a plain decimal string", () => {
    for (const input of ["", "1e18", "-1", "0x10", "1,5", "abc"]) {
      expect(() => parseAmount(input, 18, "assets")).toThrow(ToolError);
    }
  });

  it("rejects zero where a positive amount is required", () => {
    expect(() => parsePositiveAmount("0.0", 18, "assets")).toThrow(/greater than zero/);
  });
});

describe("views", () => {
  it("formats amounts and basis points", () => {
    expect(amountView(1_234_500n, { symbol: "USDC", decimals: 6 })).toEqual({
      raw: "1234500",
      human: "1.2345",
      symbol: "USDC",
    });
    expect(bpsView(250)).toEqual({ bps: 250, percent: "2.50%" });
  });
});
