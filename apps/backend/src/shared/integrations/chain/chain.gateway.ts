import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NETWORKS,
  parseDeployment,
  SelioClient,
  type Deployment,
  type NetworkKey,
  type TokenInfo,
} from "@selio/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { AppError } from "../../errors/AppError.js";

export interface ChainGatewayOptions {
  deploymentsDir: string;
  rpcUrls: Partial<Record<NetworkKey, string>>;
  rpcTimeoutMs?: number;
}

export interface CapacityReading {
  withdrawable: bigint;
  supplied: bigint;
  utilizationBps: number;
  debtorCapacity: bigint;
  sessionAssets: bigint;
  bidCapacity: { discountBps: number; assets: bigint }[];
  underlying: TokenInfo;
}

interface LoadedDeployment {
  deployment: Deployment;
  path: string;
  mtimeMs: number;
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" ? short : err.message;
  }
  return "unknown error";
}

function upstream(err: unknown, what: string): AppError {
  return new AppError(502, "UPSTREAM_ERROR", `${what}: ${reason(err)}`);
}

/** Deployment files, RPC clients and SDK clients for every network; the one place the backend reads chains. */
export class ChainGateway {
  private readonly clients = new Map<NetworkKey, PublicClient>();
  private readonly sdks = new Map<NetworkKey, { mtimeMs: number; path: string; sdk: SelioClient }>();

  constructor(private readonly options: ChainGatewayOptions) {}

  rpcUrl(key: NetworkKey): string {
    return this.options.rpcUrls[key] ?? NETWORKS[key].defaultRpcUrl;
  }

  deployment(key: NetworkKey): Deployment | null {
    return this.load(key)?.deployment ?? null;
  }

  requireDeployment(key: NetworkKey): Deployment {
    const deployment = this.deployment(key);
    if (!deployment) throw new AppError(404, "DEPLOYMENT_NOT_FOUND", `No Selio deployment for ${key}`);
    return deployment;
  }

  deployedNetworks(): NetworkKey[] {
    return (Object.keys(NETWORKS) as NetworkKey[]).filter((key) => this.deployment(key) !== null);
  }

  publicClient(key: NetworkKey): PublicClient {
    let client = this.clients.get(key);
    if (!client) {
      client = createPublicClient({
        chain: NETWORKS[key].chain,
        transport: http(this.rpcUrl(key), { timeout: this.options.rpcTimeoutMs ?? 15_000 }),
      }) as PublicClient;
      this.clients.set(key, client);
    }
    return client;
  }

  /** `eth_chainId` answered within `timeoutMs`, without retries; the chain id itself is not compared. */
  async isReachable(key: NetworkKey, timeoutMs = 3_000): Promise<boolean> {
    try {
      await createPublicClient({ transport: http(this.rpcUrl(key), { timeout: timeoutMs, retryCount: 0 }) }).getChainId();
      return true;
    } catch {
      return false;
    }
  }

  async readCapacity(key: NetworkKey, levels: readonly number[]): Promise<CapacityReading> {
    const sdk = this.sdk(key);
    if (!sdk) throw new AppError(404, "DEPLOYMENT_NOT_FOUND", `No Selio deployment for ${key}`);
    try {
      const [capacity, underlying, ...bids] = await Promise.all([
        sdk.capacity(),
        sdk.token(sdk.deployment.underlying),
        ...levels.map((d) => sdk.bidCapacityAt(d)),
      ]);
      return {
        ...capacity,
        bidCapacity: levels.map((d, i) => ({ discountBps: d, assets: bids[i] ?? 0n })),
        underlying,
      };
    } catch (err) {
      throw upstream(err, `Reading capacity on ${key} failed`);
    }
  }

  private sdk(key: NetworkKey): SelioClient | null {
    const loaded = this.load(key);
    if (!loaded) return null;
    const cached = this.sdks.get(key);
    if (cached && cached.path === loaded.path && cached.mtimeMs === loaded.mtimeMs) return cached.sdk;
    const sdk = new SelioClient(loaded.deployment, this.publicClient(key));
    this.sdks.set(key, { mtimeMs: loaded.mtimeMs, path: loaded.path, sdk });
    return sdk;
  }

  /** Re-read on every use; a file for another network or one that does not parse counts as no deployment. */
  private load(key: NetworkKey): LoadedDeployment | null {
    const dir = this.options.deploymentsDir;
    // Local fork deployments only stand in for a live network when its RPC is overridden (pointed at a fork).
    const allowLocal = NETWORKS[key].isFork || this.options.rpcUrls[key] !== undefined;
    const candidates = [join(dir, `${key}.json`), ...(allowLocal ? [join(dir, "local", `${key}.json`)] : [])];
    const path = candidates.find((p) => existsSync(p));
    if (!path) return null;
    try {
      const deployment = parseDeployment(JSON.parse(readFileSync(path, "utf8")));
      if (deployment.network !== key) return null;
      return { deployment, path, mtimeMs: statSync(path).mtimeMs };
    } catch {
      return null;
    }
  }
}
