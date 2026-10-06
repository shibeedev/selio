import { formatUnits, parseUnits } from "viem";
import { formatBps } from "@selio/sdk";
import { ToolError } from "./errors.js";

export const DECIMAL_RE = /^\d+(\.\d+)?$/;

export interface AmountView {
  /** Base units, as a decimal string. */
  raw: string;
  human: string;
  symbol: string;
}

export interface BpsView {
  bps: number;
  percent: string;
}

/** Converts a human decimal string ("1.5") to base units, rejecting more precision than the token has. */
export function parseAmount(input: string, decimals: number, field: string): bigint {
  const value = input.trim();
  if (!DECIMAL_RE.test(value)) throw new ToolError(`${field} must be a decimal string such as "1.5", got "${input}"`);
  const fraction = value.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    throw new ToolError(`${field} has ${fraction.length} decimals but the token only has ${decimals}`);
  }
  return parseUnits(value, decimals);
}

export function parsePositiveAmount(input: string, decimals: number, field: string): bigint {
  const raw = parseAmount(input, decimals, field);
  if (raw === 0n) throw new ToolError(`${field} must be greater than zero`);
  return raw;
}

export function amountView(raw: bigint, token: { symbol: string; decimals: number }): AmountView {
  return { raw: raw.toString(), human: formatUnits(raw, token.decimals), symbol: token.symbol };
}

export function bpsView(bps: number): BpsView {
  return { bps, percent: formatBps(bps) };
}
