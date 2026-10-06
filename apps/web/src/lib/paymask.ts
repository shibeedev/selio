import { isAddressEqual, zeroAddress, type Address } from "viem";
import type { Deployment } from "@selio/sdk";

/** Bit i set = payment token i accepted; the mask is a uint8, so at most 8 tokens. */
export function buildPayMask(indices: readonly number[]): number {
  let mask = 0;
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i > 7) throw new Error(`pay token index out of range: ${i}`);
    mask |= 1 << i;
  }
  return mask;
}

export function maskIncludes(mask: number, index: number): boolean {
  return ((mask >> index) & 1) === 1;
}

export function maskIndices(mask: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => i).filter((i) => maskIncludes(mask, i));
}

export function allPayMask(count: number): number {
  return buildPayMask(Array.from({ length: count }, (_, i) => i));
}

/** Aave flash mode pays from the collateral aToken of a payment asset, never in the receipt's own underlying. */
export function aaveFlashPayIndices(d: Pick<Deployment, "payTokens" | "payATokens" | "underlying">): number[] {
  const out: number[] = [];
  d.payTokens.forEach((token, i) => {
    const aToken = d.payATokens?.[i];
    if (aToken && !isAddressEqual(aToken, zeroAddress) && !isAddressEqual(token, d.underlying)) out.push(i);
  });
  return out;
}

/** Morpho flash mode pays in the collateral token of the buyer's market. */
export function morphoFlashPayIndex(payTokens: readonly Address[], collateralToken: Address | undefined): number | null {
  if (!collateralToken) return null;
  const i = payTokens.findIndex((t) => isAddressEqual(t, collateralToken));
  return i >= 0 ? i : null;
}
