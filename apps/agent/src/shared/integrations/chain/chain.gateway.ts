import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NETWORKS, SelioClient, aaveExitMarketAbi, parseDeployment, type Deployment, type TokenInfo } from "@selio/sdk";
import {
  createPublicClient,
  http,
  isAddressEqual,
  parseEventLogs,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { AppError, ErrorCode } from "../../errors/AppError.js";

/** The only network the agent acts on, and its chain id. */
export const AGENT_NETWORK = "monad-testnet" as const;
export const AGENT_CHAIN_ID = 10143;

export interface BidState {
  bidder: Address;
  minDiscountBps: number;
  payIdx: number;
  maxAssets: bigint;
  escrow: bigint;
}

export interface PreparedTx {
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface ReceiptView {
  status: "success" | "reverted";
  /** Id from the market's `BidPlaced` event, when the transaction placed a bid. */
  placedBidId: bigint | null;
}

/** What the executor needs from Monad testnet; the gateway below implements it, tests fake it. */
export interface ChainPort {
  deployment(): Deployment;
  chainId(): Promise<number>;
  token(address: Address): Promise<TokenInfo>;
  payTokens(): Promise<TokenInfo[]>;
  balanceOf(token: Address, account: Address): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  receiptValueOf(account: Address): Promise<bigint>;
  receiptAmountFor(assets: bigint): Promise<bigint>;
  quote(assets: bigint, discountBps: number, payToken: Address): Promise<bigint>;
  bid(bidId: bigint): Promise<BidState>;
  minEscrowOf(payToken: Address): Promise<bigint>;
  assetsFor(payAmount: bigint, discountBps: number, payToken: Address): Promise<bigint>;
  nativeBalance(account: Address): Promise<bigint>;
  prepare(tx: { from: Address; to: Address; data: Hex }): Promise<PreparedTx>;
  sendRawTransaction(serialized: Hex): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<ReceiptView>;
  findReceipt(hash: Hex): Promise<ReceiptView | null>;
}

export interface ChainGatewayOptions {
  deploymentsDir: string;
  rpcUrl: string;
  rpcTimeoutMs?: number;
  receiptTimeoutMs?: number;
}

/** Same buffer as the web app: Monad charges the gas limit and estimates can be short. */
export const withGasBuffer = (estimate: bigint) => (estimate * 13n) / 10n;

/**
 * viem public client for monad-testnet, the deployment `<DEPLOYMENTS_DIR>/monad-testnet.json`
 * (re-read when the file changes) and a SelioClient for it.
 */
export class ChainGateway implements ChainPort {
  readonly client: PublicClient;
  private loaded?: { mtimeMs: number; deployment: Deployment; sdk: SelioClient };
  private connectedChainId?: number;

  constructor(private readonly options: ChainGatewayOptions) {
    this.client = createPublicClient({
      chain: NETWORKS[AGENT_NETWORK].chain,
      transport: http(options.rpcUrl, { timeout: options.rpcTimeoutMs ?? 15_000 }),
    });
  }

  deployment(): Deployment {
    return this.load().deployment;
  }

  async chainId(): Promise<number> {
    this.connectedChainId ??= await this.client.getChainId();
    return this.connectedChainId;
  }

  token(address: Address) {
    return this.sdk().token(address);
  }

  payTokens() {
    return this.sdk().payTokens();
  }

  balanceOf(token: Address, account: Address) {
    return this.sdk().balanceOf(token, account);
  }

  allowance(token: Address, owner: Address, spender: Address) {
    return this.sdk().allowance(token, owner, spender);
  }

  receiptValueOf(account: Address) {
    return this.sdk().receiptValueOf(account);
  }

  receiptAmountFor(assets: bigint) {
    return this.sdk().receiptAmountFor(assets);
  }

  quote(assets: bigint, discountBps: number, payToken: Address) {
    return this.sdk().quote(assets, discountBps, payToken);
  }

  async bid(bidId: bigint): Promise<BidState> {
    const [bidder, minDiscountBps, payIdx, maxAssets, escrow] = await this.client.readContract({
      address: this.deployment().market,
      abi: aaveExitMarketAbi,
      functionName: "bids",
      args: [bidId],
    });
    return { bidder, minDiscountBps, payIdx, maxAssets, escrow };
  }

  minEscrowOf(payToken: Address) {
    return this.client.readContract({
      address: this.deployment().market,
      abi: aaveExitMarketAbi,
      functionName: "minEscrowOf",
      args: [payToken],
    });
  }

  assetsFor(payAmount: bigint, discountBps: number, payToken: Address) {
    return this.client.readContract({
      address: this.deployment().market,
      abi: aaveExitMarketAbi,
      functionName: "assetsFor",
      args: [payAmount, discountBps, payToken],
    });
  }

  nativeBalance(account: Address) {
    return this.client.getBalance({ address: account });
  }

  async prepare({ from, to, data }: { from: Address; to: Address; data: Hex }): Promise<PreparedTx> {
    const [nonce, estimate, fees] = await Promise.all([
      this.client.getTransactionCount({ address: from, blockTag: "pending" }),
      this.client.estimateGas({ account: from, to, data, value: 0n }),
      this.client.estimateFeesPerGas(),
    ]);
    return { nonce, gas: withGasBuffer(estimate), maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }

  sendRawTransaction(serialized: Hex) {
    return this.client.sendRawTransaction({ serializedTransaction: serialized });
  }

  async waitForReceipt(hash: Hex): Promise<ReceiptView> {
    return this.view(await this.client.waitForTransactionReceipt({ hash, timeout: this.options.receiptTimeoutMs ?? 120_000 }));
  }

  async findReceipt(hash: Hex): Promise<ReceiptView | null> {
    try {
      return this.view(await this.client.getTransactionReceipt({ hash }));
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
  }

  private view(receipt: TransactionReceipt): ReceiptView {
    let market: Address | undefined;
    try {
      market = this.deployment().market;
    } catch {
      market = undefined;
    }
    const placed = market
      ? parseEventLogs({ abi: aaveExitMarketAbi, logs: receipt.logs, eventName: "BidPlaced" }).find((log) =>
          isAddressEqual(log.address, market),
        )
      : undefined;
    return { status: receipt.status, placedBidId: placed ? placed.args.bidId : null };
  }

  private sdk(): SelioClient {
    return this.load().sdk;
  }

  private load() {
    const path = join(this.options.deploymentsDir, `${AGENT_NETWORK}.json`);
    const missing = () =>
      new AppError(503, ErrorCode.DEPLOYMENT_NOT_FOUND, `No valid Selio deployment for ${AGENT_NETWORK} at ${path}`);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      throw missing();
    }
    if (this.loaded?.mtimeMs === mtimeMs) return this.loaded;
    let deployment: Deployment;
    try {
      deployment = parseDeployment(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      throw missing();
    }
    if (deployment.network !== AGENT_NETWORK || deployment.chainId !== AGENT_CHAIN_ID) throw missing();
    this.loaded = { mtimeMs, deployment, sdk: new SelioClient(deployment, this.client) };
    return this.loaded;
  }
}
