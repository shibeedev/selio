import type { Address, Chain, Hex } from "viem";
import { monad, monadTestnet } from "viem/chains";

export type NetworkKey = "monad-testnet" | "usdt0-replay" | "vault-freeze";

export type Venue = "aave" | "morpho";

export interface NetworkInfo {
  key: NetworkKey;
  label: string;
  description: string;
  chain: Chain;
  venue: Venue;
  /** Fork scenarios run on a local or hosted fork node, not on the public chain. */
  isFork: boolean;
  /** Selio's event index covers this network. */
  indexed: boolean;
  defaultRpcUrl: string;
  explorerUrl?: string;
}

export const NETWORKS: Record<NetworkKey, NetworkInfo> = {
  "monad-testnet": {
    key: "monad-testnet",
    label: "Monad Testnet",
    description: "Live testnet · Morpho Earn (sim) · USDC",
    chain: monadTestnet,
    venue: "morpho",
    isFork: false,
    indexed: true,
    defaultRpcUrl: "https://testnet-rpc.monad.xyz",
    explorerUrl: "https://testnet.monadscan.com",
  },
  "usdt0-replay": {
    key: "usdt0-replay",
    label: "USDT0 replay",
    description: "Monad fork · 7 Aug 2026 · Aave USDT0 at 100%",
    chain: { ...monad, rpcUrls: { default: { http: ["http://127.0.0.1:8602"] } } },
    venue: "aave",
    isFork: true,
    indexed: false,
    defaultRpcUrl: "http://127.0.0.1:8602",
  },
  "vault-freeze": {
    key: "vault-freeze",
    label: "Vault freeze",
    description: "Monad fork · USDC vault with no withdrawable liquidity",
    chain: { ...monad, rpcUrls: { default: { http: ["http://127.0.0.1:8604"] } } },
    venue: "morpho",
    isFork: true,
    indexed: false,
    defaultRpcUrl: "http://127.0.0.1:8604",
  },
};

/** Addresses written by contracts/script/Deploy.s.sol. */
export interface Deployment {
  network: NetworkKey;
  chainId: number;
  deployBlock: number;
  venue: Venue;
  market: Address;
  receipt: Address;
  underlying: Address;
  priceRouter: Address;
  selioVault: Address;
  payTokens: Address[];
  // Aave
  aavePool?: Address;
  debtToken?: Address;
  payATokens?: Address[];
  collateralRoute?: Address;
  externalFlash?: Address;
  // Morpho
  morpho?: Address;
  earnVault?: Address;
  adapter?: Address;
  collateral?: Address;
  earnMarketId?: Hex;
  flashMarketId?: Hex;
  // Kuru (monad-testnet and usdt0-replay): all six or none
  kuruRouter?: Address;
  kuruMarginAccount?: Address;
  kuruMarket?: Address;
  /** Token the Kuru market trades: the receipt itself, or its static wrapper. */
  kuruBase?: Address;
  /** Aave static aToken wrapper of the receipt; the zero address when the market trades the receipt. */
  kuruWrapper?: Address;
  kuruSellRouter?: Address;
}

const KURU_KEYS = [
  "kuruRouter",
  "kuruMarginAccount",
  "kuruMarket",
  "kuruBase",
  "kuruWrapper",
  "kuruSellRouter",
] as const;

const isAddressString = (value: unknown): boolean => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

const REQUIRED = [
  "network",
  "chainId",
  "venue",
  "market",
  "receipt",
  "underlying",
  "priceRouter",
  "selioVault",
  "payTokens",
] as const;

/** Validates a deployment JSON object; throws with the first missing field. */
export function parseDeployment(raw: unknown): Deployment {
  if (typeof raw !== "object" || raw === null) throw new Error("deployment: not an object");
  const d = raw as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (d[key] === undefined) throw new Error(`deployment: missing ${key}`);
  }
  if (d.venue === "aave" && (!d.aavePool || !d.debtToken)) throw new Error("deployment: aave fields missing");
  if (d.venue === "morpho" && (!d.morpho || !d.earnVault || !d.adapter)) {
    throw new Error("deployment: morpho fields missing");
  }
  if (KURU_KEYS.some((key) => d[key] !== undefined) && !KURU_KEYS.every((key) => isAddressString(d[key]))) {
    throw new Error(`deployment ${String(d.network)}: missing kuru keys`);
  }
  return d as unknown as Deployment;
}
