import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { aaveFlashPayIndices, allPayMask, buildPayMask, maskIncludes, maskIndices, morphoFlashPayIndex } from "./paymask";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

describe("pay masks", () => {
  it("sets one bit per payment index", () => {
    expect(buildPayMask([0])).toBe(1);
    expect(buildPayMask([0, 2])).toBe(5);
    expect(buildPayMask([])).toBe(0);
    expect(allPayMask(3)).toBe(7);
    expect(allPayMask(8)).toBe(255);
  });

  it("rejects indices that do not fit a uint8 mask", () => {
    expect(() => buildPayMask([8])).toThrow(/out of range: 8/);
    expect(() => buildPayMask([-1])).toThrow(/out of range/);
  });

  it("reads the bits back", () => {
    expect(maskIncludes(5, 0)).toBe(true);
    expect(maskIncludes(5, 1)).toBe(false);
    expect(maskIndices(0b1011, 4)).toEqual([0, 1, 3]);
    expect(maskIndices(0b1011, 2)).toEqual([0, 1]);
  });

  it("pays Aave flash mode only from configured aTokens, never in the underlying", () => {
    const d = { payTokens: [a(1), a(2), a(3)], payATokens: [zeroAddress, a(12), a(13)], underlying: a(3) };
    expect(aaveFlashPayIndices(d)).toEqual([1]);
    expect(aaveFlashPayIndices({ payTokens: [a(1)], underlying: a(3) })).toEqual([]);
  });

  it("pays Morpho flash mode in the market's collateral token", () => {
    expect(morphoFlashPayIndex([a(1), a(2)], a(2))).toBe(1);
    expect(morphoFlashPayIndex([a(1), a(2)], a(9))).toBeNull();
    expect(morphoFlashPayIndex([a(1), a(2)], undefined)).toBeNull();
  });
});
