import { formatUnits, maxUint256, parseUnits } from "viem";
import { formatBps, formatUnitsShort } from "@selio/sdk";

export { formatBps };

/** Tokens with 9 or more decimals show 4 decimals; the others show 2. */
export function displayDecimals(decimals: number): number {
  return decimals >= 9 ? 4 : 2;
}

export function formatAmount(value: bigint, decimals: number, maxDecimals = displayDecimals(decimals)): string {
  if (value === 0n) return "0";
  const negative = value < 0n;
  let text = formatUnitsShort(negative ? -value : value, decimals, maxDecimals);
  // A non-zero amount never reads as zero.
  if (text === "0") text = `< ${(10 ** -maxDecimals).toFixed(maxDecimals)}`;
  return negative ? `-${text}` : text;
}

export function formatToken(value: bigint, token: { decimals: number; symbol: string }, maxDecimals?: number): string {
  return `${formatAmount(value, token.decimals, maxDecimals)} ${token.symbol}`;
}

/** Exact decimal text for an input field (no thousands separators). */
export function toInputString(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

export function parseAmountInput(input: string, decimals: number): { value: bigint | null; error: string | null } {
  const text = input.trim().replace(/[,_\s]/g, "");
  if (!text) return { value: null, error: null };
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return { value: null, error: "Enter a number, like 1.5" };
  const fraction = text.split(".")[1] ?? "";
  if (fraction.length > decimals) return { value: null, error: `At most ${decimals} decimals` };
  return { value: parseUnits(text, decimals), error: null };
}

export function parsePercentToBps(input: string): number | null {
  const text = input.trim().replace(/%$/, "").trim();
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

export function bpsToPercentInput(bps: number): string {
  return (bps / 100).toFixed(2);
}

/** A 1e18-scaled health factor. */
export function formatHealth(health: bigint): string {
  if (health >= maxUint256 / 2n) return "No debt";
  if (health > 1000n * 10n ** 18n) return "> 1,000";
  return (Number(health / 10n ** 14n) / 10000).toFixed(2);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} m`;
  if (m > 0) return `${m} m`;
  return `${s} s`;
}

/** Shortens addresses and transaction hashes. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export type PoolTone = "open" | "tight" | "frozen";

// Status bands assumed by the mockup (BRD TODO): frozen from 99%, tight from 90%.
export function utilizationTone(utilizationBps: number): PoolTone {
  if (utilizationBps >= 9_900) return "frozen";
  if (utilizationBps >= 9_000) return "tight";
  return "open";
}

export const TONE_LABEL: Record<PoolTone, string> = { open: "Open", tight: "Tight", frozen: "Frozen" };

export function formatShare(part: bigint, whole: bigint): string {
  if (whole === 0n) return "0.00%";
  return `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(2)}%`;
}
