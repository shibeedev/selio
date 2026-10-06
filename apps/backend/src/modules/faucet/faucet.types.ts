import type { NetworkKey } from "@selio/sdk";

export type KitType = "seller" | "borrower" | "bidder";

/** One kit of each type per address and network per window. */
export const FAUCET_WINDOW_MS = 10 * 60_000;
/** Well above a slow fork's kit time, ~1 min. */
export const FAUCET_LOCK_TTL_MS = 10 * 60_000;
export const FAUCET_LOCK_WAIT_MS = 60_000;
export const FAUCET_LOCK_POLL_MS = 250;
/** Per-IP budget across both forks and all kit types: kits and distinct addresses per window. */
export const FAUCET_IP_WINDOW_MS = 60 * 60_000;
export const FAUCET_IP_BUDGET = 12;
export const FAUCET_IP_ADDRESSES = 4;

export interface KitRunner {
  /** Runs one kit and returns human-readable lines describing what it did. */
  runKit(network: NetworkKey, kit: KitType, address: string): Promise<string[]>;
}

export interface FaucetResult {
  ok: true;
  actions: string[];
}
