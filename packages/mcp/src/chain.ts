import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient, type Transport } from "viem";
import {
  NETWORKS,
  SelioClient,
  morphoAbi,
  parseDeployment,
  selioVaultAbi,
  vaultV2Abi,
  type Deployment,
  type NetworkInfo,
  type NetworkKey,
} from "@selio/sdk";
import { countRead } from "./budget.js";
import { NETWORK_KEYS, defaultDeploymentsDir, type ChainLayerOptions } from "./config.js";
import { ToolError, findToolError } from "./errors.js";

/** The SDK surface the tools use. SelioClient satisfies it; tests stub its reads. */
export type MarketSdk = Pick<
  SelioClient,
  | "deployment"
  | "token"
  | "payTokens"
  | "capacity"
  | "bidCapacityAt"
  | "session"
  | "sessions"
  | "bids"
  | "quote"
  | "feeBps"
  | "feeOf"
  | "sellerQuote"
  | "balanceOf"
  | "vaultPreviewDeposit"
  | "receiptAmountFor"
  | "allowance"
  | "collateralPullMargin"
  | "position"
  | "venueData"
  | "planSellNow"
  | "approve"
  | "openSession"
  | "withdrawUnsold"
  | "buyAndRepay"
  | "buyAndRepayWithCollateral"
  | "placeBid"
  | "cancelBid"
  | "sellNow"
  | "vaultDeposit"
  | "vaultRedeem"
  | "routeRepayWithFrozenCollateral"
>;

export type CallOutcome = { ok: true; returnData: Hex } | { ok: false; revertData?: Hex; message: string };

/** The Selio Vault's base-yield position (Part 0 §0.13). */
export interface BaseYieldState {
  /** ERC-4626 yield source; its shares are the source's receipt. */
  source: Address;
  sourceShares: bigint;
  /** sourceShares valued in the vault asset. */
  sourceAssets: bigint;
  sourceUtilizationBps: number;
}

/** Chain reads the SDK does not expose. */
export interface ChainReads {
  vaultAsset(): Promise<Address>;
  /** What redeeming `shares` pays now, in receipts, and in source shares the yield source cannot pay now. */
  vaultPreviewRedeem(shares: bigint): Promise<{ assets: bigint; receipts: readonly bigint[]; sourceSharesInKind: bigint }>;
  /** The Selio Vault's yield source and its position there; null when the vault has none. */
  vaultBaseYield(): Promise<BaseYieldState | null>;
  morphoNonce(account: Address): Promise<bigint>;
  /** The Earn vault's liquidity adapter and liquidity data: plain vault withdrawals are served from that market. */
  morphoLiquidity(): Promise<{ adapter: Address; data: Hex }>;
  latestTimestamp(): Promise<bigint>;
  call(tx: { from: Address; to: Address; data: Hex; value: bigint }): Promise<CallOutcome>;
}

export interface NetworkHandle {
  info: NetworkInfo;
  deployment: Deployment;
  sdk: MarketSdk;
  reads: ChainReads;
}

export interface NetworkListing {
  info: NetworkInfo;
  deployment: Deployment | null;
}

export interface SelioChain {
  list(): NetworkListing[];
  /** Throws a ToolError when the network has no deployment. */
  get(key: NetworkKey): NetworkHandle;
}

const isRevertHex = (value: unknown): value is Hex =>
  typeof value === "string" && value.startsWith("0x") && value.length > 2;

/** First non-empty `data` hex string along an error's cause chain (viem nests the RPC error). */
export function findRevertData(err: unknown): Hex | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 10 && typeof current === "object" && current !== null; depth++) {
    const data = (current as { data?: unknown }).data;
    if (isRevertHex(data)) return data;
    if (typeof data === "object" && data !== null) {
      const nested = (data as { data?: unknown }).data;
      if (isRevertHex(nested)) return nested;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const liquidityDataAbi = parseAbi(["function liquidityData() view returns (bytes)"]);

class RpcReads implements ChainReads {
  constructor(
    private readonly client: PublicClient,
    private readonly deployment: Deployment,
  ) {}

  vaultAsset(): Promise<Address> {
    return this.client.readContract({ address: this.deployment.selioVault, abi: selioVaultAbi, functionName: "asset" });
  }

  async vaultPreviewRedeem(
    shares: bigint,
  ): Promise<{ assets: bigint; receipts: readonly bigint[]; sourceSharesInKind: bigint }> {
    const [assets, receipts, sourceSharesInKind] = await this.client.readContract({
      address: this.deployment.selioVault,
      abi: selioVaultAbi,
      functionName: "previewRedeem",
      args: [shares],
    });
    return { assets, receipts, sourceSharesInKind };
  }

  async vaultBaseYield(): Promise<BaseYieldState | null> {
    const vault = { address: this.deployment.selioVault, abi: selioVaultAbi } as const;
    const source = await this.client.readContract({ ...vault, functionName: "yieldSource" });
    if (/^0x0{40}$/i.test(source)) return null;
    const [sourceShares, sourceAssets, utilization] = await Promise.all([
      this.client.readContract({ ...vault, functionName: "sourceShares" }),
      this.client.readContract({ ...vault, functionName: "sourceAssets" }),
      this.client.readContract({ ...vault, functionName: "sourceUtilizationBps" }),
    ]);
    return { source, sourceShares, sourceAssets, sourceUtilizationBps: Number(utilization) };
  }

  async morphoNonce(account: Address): Promise<bigint> {
    const morpho = this.deployment.morpho;
    if (!morpho) throw new ToolError("this network has no Morpho deployment");
    return this.client.readContract({ address: morpho, abi: morphoAbi, functionName: "nonce", args: [account] });
  }

  async morphoLiquidity(): Promise<{ adapter: Address; data: Hex }> {
    const vault = this.deployment.earnVault;
    if (!vault) throw new ToolError("this network has no Morpho deployment");
    const [adapter, data] = await Promise.all([
      this.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "liquidityAdapter" }),
      this.client.readContract({ address: vault, abi: liquidityDataAbi, functionName: "liquidityData" }),
    ]);
    return { adapter, data };
  }

  async latestTimestamp(): Promise<bigint> {
    return (await this.client.getBlock()).timestamp;
  }

  async call(tx: { from: Address; to: Address; data: Hex; value: bigint }): Promise<CallOutcome> {
    try {
      const res = await this.client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value });
      return { ok: true, returnData: res.data ?? "0x" };
    } catch (err) {
      // A spent read budget is the endpoint's limit, not the transaction's revert.
      const limit = findToolError(err);
      if (limit) throw limit;
      const short = typeof err === "object" && err !== null ? (err as { shortMessage?: unknown }).shortMessage : undefined;
      const message = typeof short === "string" ? short : err instanceof Error ? err.message : "call failed";
      return { ok: false, revertData: findRevertData(err), message };
    }
  }
}

/** Counts every JSON-RPC request against the read budget. It wraps the transport's request, outside viem's retries. */
function countedTransport(transport: Transport): Transport {
  return ((options) => {
    const inner = transport(options);
    const request = (async (...args: Parameters<typeof inner.request>) => {
      countRead();
      return inner.request(...args);
    }) as typeof inner.request;
    return { ...inner, request };
  }) as Transport;
}

interface LoadedDeployment {
  deployment: Deployment;
  path: string;
  mtimeMs: number;
}

/** Network access over JSON-RPC, with deployments read from disk (re-read when the file changes). */
export class RpcChainLayer implements SelioChain {
  private readonly deploymentsDir: string;
  private readonly handles = new Map<NetworkKey, { mtimeMs: number; path: string; handle: NetworkHandle }>();

  constructor(private readonly options: ChainLayerOptions = {}) {
    this.deploymentsDir = options.deploymentsDir ?? defaultDeploymentsDir();
  }

  rpcUrl(key: NetworkKey): string {
    return this.options.rpcUrls?.[key] ?? NETWORKS[key].defaultRpcUrl;
  }

  list(): NetworkListing[] {
    return NETWORK_KEYS.map((key) => {
      let deployment: Deployment | null = null;
      try {
        deployment = this.load(key)?.deployment ?? null;
      } catch {
        deployment = null;
      }
      return { info: NETWORKS[key], deployment };
    });
  }

  get(key: NetworkKey): NetworkHandle {
    const loaded = this.load(key);
    if (!loaded) throw new ToolError(`No Selio deployment found for ${key}. Use list_networks to see deployed networks.`);
    const cached = this.handles.get(key);
    if (cached && cached.mtimeMs === loaded.mtimeMs && cached.path === loaded.path) return cached.handle;
    const client = createPublicClient({
      chain: NETWORKS[key].chain,
      transport: countedTransport(http(this.rpcUrl(key), { timeout: 20_000 })),
    }) as PublicClient;
    const handle: NetworkHandle = {
      info: NETWORKS[key],
      deployment: loaded.deployment,
      sdk: new SelioClient(loaded.deployment, client),
      reads: new RpcReads(client, loaded.deployment),
    };
    this.handles.set(key, { mtimeMs: loaded.mtimeMs, path: loaded.path, handle });
    return handle;
  }

  private load(key: NetworkKey): LoadedDeployment | null {
    // Local fork deployments only stand in for a live network when its RPC is overridden (pointed at a fork).
    const allowLocal = NETWORKS[key].isFork || this.options.rpcUrls?.[key] !== undefined;
    const candidates = [join(this.deploymentsDir, `${key}.json`)];
    if (allowLocal) candidates.push(join(this.deploymentsDir, "local", `${key}.json`));
    const path = candidates.find((p) => existsSync(p));
    if (!path) return null;
    let deployment: Deployment;
    try {
      deployment = parseDeployment(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      throw new ToolError(`${path} is not a valid Selio deployment file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (deployment.network !== key) throw new ToolError(`${path} describes ${deployment.network}, not ${key}`);
    return { deployment, path, mtimeMs: statSync(path).mtimeMs };
  }
}

export function createChainLayer(options: ChainLayerOptions = {}): SelioChain {
  return new RpcChainLayer(options);
}
