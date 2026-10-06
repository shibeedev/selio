import type { NetworkKey, Venue } from "@selio/sdk";
import type { Address } from "viem";

export interface NetworkSummary {
  key: NetworkKey;
  label: string;
  description: string;
  venue: Venue;
  isFork: boolean;
  chainId: number;
  explorerUrl: string | null;
  deploymentLoaded: boolean;
  market: Address | null;
  rpcReachable: boolean;
}
