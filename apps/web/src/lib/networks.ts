import type { Hex } from "viem";
import { NETWORKS, type NetworkInfo, type NetworkKey } from "@selio/sdk";

export const NETWORK_KEYS = Object.keys(NETWORKS) as NetworkKey[];

/** Provisional default (BRD 2.3.4 leaves the default network open). */
export const DEFAULT_NETWORK: NetworkKey = "monad-testnet";

export function isNetworkKey(value: unknown): value is NetworkKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NETWORKS, value);
}

export interface NetworkGroup {
  title: string;
  networks: NetworkInfo[];
}

export function networkGroups(): NetworkGroup[] {
  const all = NETWORK_KEYS.map((k) => NETWORKS[k]);
  return [
    { title: "Live networks", networks: all.filter((n) => !n.isFork) },
    { title: "Scenario forks", networks: all.filter((n) => n.isFork) },
  ];
}

export function networkKind(n: NetworkInfo): string {
  return n.isFork ? "Scenario fork" : "Live testnet";
}

export function venueLabel(n: NetworkInfo): string {
  return n.venue === "aave" ? "Aave V3" : "Morpho";
}

/** Forks have no explorer. */
export function explorerTxUrl(n: NetworkInfo, hash: Hex): string | null {
  return n.explorerUrl ? `${n.explorerUrl.replace(/\/+$/, "")}/tx/${hash}` : null;
}
