import { decodeErrorResult, type Abi, type Hex } from "viem";
import { formatAbiItem } from "viem/utils";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  kuruMarginAccountAbi,
  kuruOrderBookAbi,
  kuruSellRouterAbi,
  morphoVaultExitMarketAbi,
  priceRouterAbi,
  selioVaultAbi,
  testTokenAbi,
} from "@selio/sdk";

type AbiError = Extract<Abi[number], { type: "error" }>;

function errorItems(): AbiError[] {
  const abis: readonly Abi[] = [
    aaveExitMarketAbi,
    morphoVaultExitMarketAbi,
    selioVaultAbi,
    aaveCollateralRouteAbi,
    priceRouterAbi,
    testTokenAbi,
    kuruSellRouterAbi,
    kuruOrderBookAbi,
    kuruMarginAccountAbi,
  ];
  const seen = new Set<string>();
  const errors: AbiError[] = [];
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const key = formatAbiItem(item);
      if (seen.has(key)) continue;
      seen.add(key);
      errors.push(item);
    }
  }
  return errors;
}

/** Custom errors of every Selio contract and of the Kuru calls a routed sale makes; Error(string) and Panic(uint256) are decoded by viem itself. */
export const SELIO_ERRORS_ABI: readonly AbiError[] = errorItems();

export interface DecodedRevert {
  name: string;
  signature: string;
  args: string[];
}

function stringify(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** Decodes revert data with Selio's error ABI; returns null for unknown selectors. */
export function decodeRevert(data: Hex | undefined): DecodedRevert | null {
  if (!data || data.length < 10) return null;
  try {
    const res = decodeErrorResult({ abi: SELIO_ERRORS_ABI, data });
    return {
      name: res.errorName,
      signature: res.abiItem ? formatAbiItem(res.abiItem, { includeName: true }) : res.errorName,
      args: ((res.args ?? []) as readonly unknown[]).map(stringify),
    };
  } catch {
    return null;
  }
}
