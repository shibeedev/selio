import { isAddressEqual, zeroAddress, type Address } from "viem";
import type { TokenInfo } from "@selio/sdk";
import { formatBps, formatToken } from "./format";
import { baseYieldLine } from "./market";

/** At or above this utilization of its yield source the vault deposits nothing more and anyone can pull its capital back. */
export const SOURCE_MAX_UTILIZATION_BPS = 9_000;

/** The Selio Vault's base-yield source, as `vaultState` reports it. */
export interface BaseYieldSource {
  address: Address;
  symbol: string;
  assets: bigint;
  utilizationBps: number;
}

export function yieldSourceOf(state: {
  yieldSource: Address;
  sourceSymbol: string;
  sourceAssets: bigint;
  sourceUtilizationBps: number;
}): BaseYieldSource | null {
  if (isAddressEqual(state.yieldSource, zeroAddress)) return null;
  return {
    address: state.yieldSource,
    symbol: state.sourceSymbol,
    assets: state.sourceAssets,
    utilizationBps: state.sourceUtilizationBps,
  };
}

/** The "Base yield while waiting" rule; a vault without a source keeps its capital idle. */
export function baseYieldRule(source: BaseYieldSource | null, asset: TokenInfo): string {
  if (!source) return baseYieldLine(asset);
  return `capital beyond the bid's escrow earns yield in ${source.symbol}, outside the pool it protects, and is pulled back to cash when the source reaches ${formatBps(SOURCE_MAX_UTILIZATION_BPS, 0)} utilization`;
}

export interface PanelRow {
  label: string;
  value: string;
  testid: string;
}

/** Rows of the vault panel's base-yield block; none without a source. */
export function baseYieldRows(source: BaseYieldSource | null, asset: TokenInfo): PanelRow[] {
  if (!source) return [];
  return [
    { label: "Base yield source", value: source.symbol, testid: "vault-source" },
    { label: "In source", value: formatToken(source.assets, asset), testid: "vault-in-source" },
    { label: "Source utilization", value: formatBps(source.utilizationBps), testid: "vault-source-utilization" },
  ];
}

/** At the threshold no operation deposits into the source and the vault's capital can be pulled back. */
export function sourceIsTight(source: BaseYieldSource): boolean {
  return source.utilizationBps >= SOURCE_MAX_UTILIZATION_BPS;
}

/** What the vault is doing with its waiting capital, for the panel's status chip. */
export function sourceState(source: BaseYieldSource): { tone: "open" | "tight"; text: string } {
  const at = formatBps(source.utilizationBps);
  if (!sourceIsTight(source)) return { tone: "open", text: `Earning: source at ${at}` };
  if (source.assets === 0n) return { tone: "tight", text: `Pulled back: source at ${at}` };
  return { tone: "tight", text: `Source at ${at}: no new deposits, and anyone can pull the rest back to cash` };
}

/** The redemption preview's in-kind source part: source shares the source cannot pay out now. */
export function sourceInKindText(shares: bigint, sourceToken: TokenInfo | null): string | null {
  if (shares === 0n || !sourceToken) return null;
  return formatToken(shares, sourceToken);
}
