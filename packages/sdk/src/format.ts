import { formatUnits } from "viem";

/** Basis points as a percentage, e.g. 250 -> "2.50%". */
export function formatBps(bps: number | bigint, digits = 2): string {
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

/** Human amount with at most `maxDecimals` decimals and thousands separators. */
export function formatUnitsShort(value: bigint, decimals: number, maxDecimals = 4): string {
  return Number(formatUnits(value, decimals)).toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
}
