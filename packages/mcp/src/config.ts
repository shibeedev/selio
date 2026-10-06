import { fileURLToPath } from "node:url";
import { NETWORKS, type NetworkKey } from "@selio/sdk";

export interface ChainLayerOptions {
  /** Folder holding `<network>.json`; `<dir>/local/<network>.json` is the fallback for forks and RPC-overridden networks. */
  deploymentsDir?: string;
  /** RPC URL per network; networks without one use NETWORKS[key].defaultRpcUrl. */
  rpcUrls?: Partial<Record<NetworkKey, string>>;
}

export const NETWORK_KEYS = Object.keys(NETWORKS) as [NetworkKey, ...NetworkKey[]];

/** Environment-variable suffix of a network key: "usdt0-replay" gives "USDT0_REPLAY". */
export function envSuffix(key: NetworkKey): string {
  return key.toUpperCase().replace(/-/g, "_");
}

/** <repo>/contracts/deployments, resolved from this file (src/ or dist/ of packages/mcp). */
export function defaultDeploymentsDir(): string {
  return fileURLToPath(new URL("../../../contracts/deployments", import.meta.url));
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Reads SELIO_DEPLOYMENTS_DIR and SELIO_RPC_<KEY>; throws when an RPC value is not a URL. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): Required<ChainLayerOptions> {
  const rpcUrls: Partial<Record<NetworkKey, string>> = {};
  const problems: string[] = [];
  for (const key of NETWORK_KEYS) {
    const name = `SELIO_RPC_${envSuffix(key)}`;
    const url = env[name];
    if (!url) continue;
    if (isUrl(url)) rpcUrls[key] = url;
    else problems.push(`${name}: must be a URL`);
  }
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  return { deploymentsDir: env.SELIO_DEPLOYMENTS_DIR || defaultDeploymentsDir(), rpcUrls };
}
