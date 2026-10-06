import type { NetworkKey } from "@selio/sdk";
import type { Address } from "viem";

/** Discount levels of live bid capacity: 1, 3, 5, 10 and 20 %. */
export const BID_CAPACITY_LEVELS_BPS = [100, 300, 500, 1_000, 2_000] as const;
export const MAX_HISTORY_HOURS = 168;
export const HOUR_MS = 3_600_000;

/** Live capacity; every amount is a decimal string in the underlying's base units. */
export interface CapacityDto {
  network: NetworkKey;
  at: number;
  underlying: { address: Address; symbol: string; decimals: number };
  withdrawable: string;
  supplied: string;
  utilizationBps: number;
  debtorCapacity: string;
  sessionAssets: string;
  bidCapacity: { discountBps: number; assets: string }[];
}

export interface CapacityPoint {
  t: number;
  utilizationBps: number;
  withdrawable: string;
  supplied: string;
}

export interface CapacitySnapshot {
  network: NetworkKey;
  at: number;
  utilizationBps: number;
  withdrawable: bigint;
  supplied: bigint;
}

export type SnapshotListener = (snapshots: CapacitySnapshot[]) => Promise<void> | void;
