import { randomUUID } from "node:crypto";
import { aaveExitMarketAbi, selioVaultAbi, type Deployment, type TokenInfo } from "@selio/sdk";
import { pino } from "pino";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  keccak256,
  parseTransaction,
  parseUnits,
  recoverTransactionAddress,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DelegationRepository } from "../modules/delegations/index.js";
import type { DelegationStatus } from "../modules/delegations/index.js";
import { GrantRepository, type GrantRow } from "../modules/grants/index.js";
import { seal } from "../shared/crypto/seal.js";
import { openDatabase, type Db } from "../shared/db/database.js";
import { migrate } from "../shared/db/migrations.js";
import type { BidState, ChainPort, PreparedTx, ReceiptView } from "../shared/integrations/chain/chain.gateway.js";
import {
  DelegationRejectedError,
  serializeKeyShare,
  type DelegatedSignRequest,
  type DynamicPort,
  type EncryptedDelegation,
  type ServerKeyShare,
} from "../shared/integrations/dynamic/dynamic.gateway.js";
import { McpToolError, type McpPort } from "../shared/integrations/mcp/mcp.client.js";

export const silentLogger = pino({ level: "silent" });

export function testDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export const NOW = 1_800_000_000_000;
export const ENVIRONMENT_ID = "8f1d3c2b-4a5e-4f60-9b7a-0c1d2e3f4a5b";
export const USER_ID = "4c3b2a19-0f8e-4d7c-8b6a-5f4e3d2c1b0a";
export const OTHER_USER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const WALLET_ID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
export const STORAGE_KEY = Buffer.alloc(32, 7);
export const SELIO_SECRET = "selio-webhook-secret";
export const DYNAMIC_SECRET = "dynamic-webhook-secret";
export const REVIEW_SECRET = "dynamic-review-secret";

// anvil's public test key #1 plays the embedded wallet; its delegated signer is faked.
export const walletAccount = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const WALLET = walletAccount.address;
export const WALLET_LC = WALLET.toLowerCase();
export const OTHER_WALLET = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";

export const MARKET: Address = "0x1000000000000000000000000000000000000001";
export const VAULT: Address = "0x2000000000000000000000000000000000000002";
export const RECEIPT: Address = "0x3000000000000000000000000000000000000003";
export const USDC: Address = "0x534b2f3a21130d7a60830c2df862319e593943a3";
export const AUSD: Address = "0x5000000000000000000000000000000000000005";

export const DEPLOYMENT: Deployment = {
  network: "monad-testnet",
  chainId: 10143,
  deployBlock: 1,
  venue: "morpho",
  market: MARKET,
  receipt: RECEIPT,
  underlying: USDC,
  priceRouter: "0x6000000000000000000000000000000000000006",
  selioVault: VAULT,
  payTokens: [USDC, AUSD],
  morpho: "0x7000000000000000000000000000000000000007",
  earnVault: RECEIPT,
  adapter: "0x8000000000000000000000000000000000000008",
  collateral: AUSD,
};

const TOKENS: Record<string, TokenInfo> = {
  [USDC]: { address: USDC, symbol: "USDC", decimals: 6 },
  [AUSD]: { address: AUSD, symbol: "AUSD-sim", decimals: 18 },
  [RECEIPT]: { address: RECEIPT, symbol: "eUSDC", decimals: 18 },
};

const BPS = 10_000n;
const lc = (a: string) => a.toLowerCase();

/** Monad testnet in memory: USDC (6 dp) and AUSD-sim (18 dp) both at $1, receipts 1:1 with USDC. */
export class FakeChain implements ChainPort {
  deploymentValue: Deployment = DEPLOYMENT;
  connectedChainId = 10143;
  receiptValue = 0n;
  native = 10n ** 18n;
  prepared: PreparedTx = { nonce: 7, gas: 200_000n, maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  readonly balances = new Map<string, bigint>();
  readonly allowances = new Map<string, bigint>();
  readonly bids = new Map<bigint, BidState>();
  readonly minEscrows = new Map<string, bigint>();
  readonly sent: Hex[] = [];
  /** Hashes `findReceipt` knows (start-up reconciliation). */
  readonly mined = new Map<Hex, ReceiptView>();
  nextBidId = 42n;
  private readonly placed = new Map<Hex, bigint>();

  setBalance(token: Address, account: string, amount: bigint) {
    this.balances.set(`${lc(token)}:${lc(account)}`, amount);
  }

  setAllowance(token: Address, owner: string, spender: Address, amount: bigint) {
    this.allowances.set(`${lc(token)}:${lc(owner)}:${lc(spender)}`, amount);
  }

  deployment() {
    return this.deploymentValue;
  }
  async chainId() {
    return this.connectedChainId;
  }
  async token(address: Address) {
    const token = TOKENS[lc(address)];
    if (!token) throw new Error(`unknown token ${address}`);
    return token;
  }
  async payTokens() {
    return Promise.all(this.deploymentValue.payTokens.map((t) => this.token(t)));
  }
  async balanceOf(token: Address, account: Address) {
    return this.balances.get(`${lc(token)}:${lc(account)}`) ?? 0n;
  }
  async allowance(token: Address, owner: Address, spender: Address) {
    return this.allowances.get(`${lc(token)}:${lc(owner)}:${lc(spender)}`) ?? 0n;
  }
  async receiptValueOf() {
    return this.receiptValue;
  }
  async receiptAmountFor(assets: bigint) {
    return assets * 10n ** 12n;
  }
  /** Pay-token amount for `assets` (USDC units) at a discount, rounded up. */
  async quote(assets: bigint, discountBps: number, payToken: Address) {
    const usdc = (assets * (BPS - BigInt(discountBps)) + BPS - 1n) / BPS;
    return lc(payToken) === lc(AUSD) ? usdc * 10n ** 12n : usdc;
  }
  async bid(bidId: bigint): Promise<BidState> {
    return this.bids.get(bidId) ?? { bidder: "0x0000000000000000000000000000000000000000", minDiscountBps: 0, payIdx: 0, maxAssets: 0n, escrow: 0n };
  }
  async minEscrowOf(payToken: Address) {
    return this.minEscrows.get(lc(payToken)) ?? 0n;
  }
  async assetsFor(payAmount: bigint, discountBps: number, payToken: Address) {
    const usdc = lc(payToken) === lc(AUSD) ? payAmount / 10n ** 12n : payAmount;
    return (usdc * BPS) / (BPS - BigInt(discountBps));
  }
  async nativeBalance() {
    return this.native;
  }
  async prepare() {
    return this.prepared;
  }
  /** Broadcasts; a cancelled bid refunds its escrow and a placed bid pulls escrow and allowance, as on chain. */
  async sendRawTransaction(serialized: Hex) {
    this.sent.push(serialized);
    const hash = keccak256(serialized);
    const tx = parseTransaction(serialized);
    const from = await recoverTransactionAddress({ serializedTransaction: serialized as TransactionSerialized });
    if (!this.revertAll && tx.data && lc(tx.to ?? "") === lc(this.deploymentValue.market)) {
      const call = decodeFunctionData({ abi: aaveExitMarketAbi, data: tx.data });
      if (call.functionName === "cancelBid") {
        const [bidId] = call.args;
        const bid = this.bids.get(bidId);
        if (bid) {
          this.bids.delete(bidId);
          const pay = this.deploymentValue.payTokens[bid.payIdx]!;
          this.setBalance(pay, bid.bidder, (await this.balanceOf(pay, bid.bidder)) + bid.escrow);
        }
      }
      if (call.functionName === "placeBid") {
        const [minDiscountBps, payIdx, maxAssets, escrow] = call.args;
        const pay = this.deploymentValue.payTokens[payIdx]!;
        const id = this.nextBidId++;
        this.placed.set(hash, id);
        this.bids.set(id, { bidder: from, minDiscountBps, payIdx, maxAssets, escrow });
        this.setBalance(pay, from, (await this.balanceOf(pay, from)) - escrow);
        this.setAllowance(pay, from, this.deploymentValue.market, (await this.allowance(pay, from, this.deploymentValue.market)) - escrow);
      }
    }
    return hash;
  }
  /** Every broadcast transaction reverts while set. */
  revertAll = false;
  async waitForReceipt(hash: Hex): Promise<ReceiptView> {
    return { status: this.revertAll ? "reverted" : "success", placedBidId: this.placed.get(hash) ?? null };
  }
  async findReceipt(hash: Hex) {
    return this.mined.get(hash) ?? null;
  }

  /** The calls the wallet broadcast, decoded. */
  sentCalls() {
    return this.sent.map((raw) => {
      const tx = parseTransaction(raw);
      const abi = lc(tx.to ?? "") === lc(VAULT) ? selioVaultAbi : aaveExitMarketAbi;
      return { to: tx.to, chainId: tx.chainId, nonce: tx.nonce, gas: tx.gas, ...decodeFunctionData({ abi, data: tx.data! }) };
    });
  }
}

type Tool = (args: Record<string, unknown>) => unknown;

/**
 * The hosted MCP server as the agent sees it: the build tools encode real calldata with the SDK ABIs,
 * the way Part 5 §C.6 describes, so the policy check runs on genuine bytes.
 */
export class FakeMcp implements McpPort {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  utilizationBps = 9_950;
  simulation: { ok: boolean; revert?: { name: string } | null; message?: string } = { ok: true };
  /** Face value the bids absorb for a requested amount (USDC units). */
  planFill = (assets: bigint) => assets;
  planFills = 1;
  /** Transactions a build returns before its own (for example an unexpected approval). */
  prepend: { to: string; data: Hex; value: string }[] = [];
  readonly overrides = new Map<string, Tool>();

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    const override = this.overrides.get(name);
    if (override) return override(args);
    switch (name) {
      case "get_exit_capacity":
        return { network: args.network, utilization: { bps: this.utilizationBps, percent: `${this.utilizationBps / 100}%` } };
      case "plan_sell_now": {
        const filled = this.planFill(parseUnits(String(args.assets), 6));
        return { filled: view(filled, "USDC"), fills: Array.from({ length: filled > 0n ? this.planFills : 0 }, () => ({})), notes: [] };
      }
      case "build_sell_now": {
        const assets = this.planFill(parseUnits(String(args.assets), 6));
        if (assets === 0n) throw new McpToolError("No escrowed bid buys at or below the limit.");
        const pay = (assets * (BPS - BigInt(Number(args.maxDiscountBps)))) / BPS;
        const fee = (pay * 20n) / BPS;
        const data = encodeFunctionData({
          abi: aaveExitMarketAbi,
          functionName: "sellNow",
          args: [assets, [1n], Number(args.maxDiscountBps), maskOf(args.payTokens), parseUnits(String(args.minFilled), 6)],
        });
        return this.build([{ to: MARKET, data }], { fees: [view(fee, "USDC")], sellerNet: [view(pay - fee, "USDC")] });
      }
      case "build_place_bid": {
        const payToken = String(args.payToken);
        const decimals = TOKENS[lc(payToken)]!.decimals;
        const data = encodeFunctionData({
          abi: aaveExitMarketAbi,
          functionName: "placeBid",
          args: [
            Number(args.minDiscountBps),
            DEPLOYMENT.payTokens.findIndex((t) => lc(t) === lc(payToken)),
            parseUnits(String(args.maxAssets), 6),
            parseUnits(String(args.escrow), decimals),
          ],
        });
        return this.build([{ to: MARKET, data }]);
      }
      case "build_cancel_bid": {
        const data = encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "cancelBid", args: [BigInt(String(args.bidId))] });
        return this.build([{ to: MARKET, data }]);
      }
      case "build_vault_deposit": {
        const assets = parseUnits(String(args.assets), 6);
        const data = encodeFunctionData({
          abi: selioVaultAbi,
          functionName: "deposit",
          args: [assets, String(args.receiver) as Address, (assets * 99n) / 100n],
        });
        return this.build([{ to: VAULT, data }]);
      }
      case "simulate_transaction":
        return { network: args.network, ...this.simulation };
      default:
        throw new McpToolError(`MCP error -32602: Tool ${name} not found`);
    }
  }

  names() {
    return this.calls.map((c) => c.name);
  }

  argsOf(name: string) {
    return this.calls.find((c) => c.name === name)?.args;
  }

  private build(txs: { to: string; data: Hex }[], details: Record<string, unknown> = {}) {
    return {
      network: "monad-testnet",
      chainId: 10143,
      transactions: [...this.prepend, ...txs.map((t) => ({ ...t, value: "0", description: "built" }))],
      notes: [],
      details,
    };
  }
}

function view(raw: bigint, symbol: string) {
  return { raw: raw.toString(), human: formatUnits(raw, 6), symbol };
}

function maskOf(payTokens: unknown): number {
  const list = Array.isArray(payTokens) ? payTokens.map(String) : DEPLOYMENT.payTokens;
  return DEPLOYMENT.payTokens.reduce((mask, token, i) => (list.some((t) => lc(t) === lc(token)) ? mask | (1 << i) : mask), 0);
}

export const approveCall = (spender: Address, amount: bigint) => ({
  to: USDC as string,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  value: "0",
});

export const KEY_SHARE = { pubkey: { pubkey: "02a1b2c3" }, secretShare: "test-secret-share-material" } as unknown as ServerKeyShare;
export const WALLET_API_KEY = "test-wallet-api-key";

/** Stand-in for the hybrid RSA-OAEP + AES-GCM envelope: `ct` carries the plaintext (base64url). */
export function envelopeOf(plaintext: string) {
  return { alg: "HYBRID-RSA-AES-256", iv: "aXY", ct: Buffer.from(plaintext).toString("base64url"), tag: "dGFn", ek: "ZWs" };
}

/** Dynamic as the agent sees it; signing uses the wallet's local test key. */
export class FakeDynamic implements DynamicPort {
  readonly signed: DelegatedSignRequest[] = [];
  readonly revoked: string[] = [];
  reject = false;
  revokeResult = true;
  /** When set, every signing call waits for it (to observe the per-wallet lock). */
  gate: Promise<void> | null = null;
  signing = 0;
  maxConcurrentSigning = 0;

  decryptDelegation({ encryptedDelegatedShare, encryptedWalletApiKey }: EncryptedDelegation) {
    return {
      keyShare: JSON.parse(Buffer.from(encryptedDelegatedShare.ct, "base64url").toString()) as ServerKeyShare,
      walletApiKey: Buffer.from(encryptedWalletApiKey.ct, "base64url").toString(),
    };
  }

  async signTransaction(request: DelegatedSignRequest): Promise<Hex> {
    this.signing++;
    this.maxConcurrentSigning = Math.max(this.maxConcurrentSigning, this.signing);
    try {
      if (this.gate) await this.gate;
      this.signed.push(request);
      if (this.reject) throw new DelegationRejectedError();
      return await walletAccount.signTransaction(request.transaction);
    } finally {
      this.signing--;
    }
  }

  async revokeDelegatedAccess(walletId: string) {
    this.revoked.push(walletId);
    return this.revokeResult;
  }
}

export function seedDelegation(
  db: Db,
  overrides: { walletId?: string; address?: string; userId?: string; status?: DelegationStatus; eventAt?: number } = {},
) {
  const walletId = overrides.walletId ?? WALLET_ID;
  const status = overrides.status ?? "active";
  new DelegationRepository(db).save(
    {
      walletId,
      userId: overrides.userId ?? USER_ID,
      address: overrides.address ?? WALLET_LC,
      shareSetId: "share-set-1",
      sealedShare: status === "active" ? seal(serializeKeyShare(KEY_SHARE), STORAGE_KEY, walletId) : null,
      sealedApiKey: status === "active" ? seal(WALLET_API_KEY, STORAGE_KEY, walletId) : null,
      status,
      eventAt: overrides.eventAt ?? NOW - 60_000,
    },
    NOW - 60_000,
  );
}

export function seedGrant(db: Db, overrides: Partial<GrantRow> = {}): GrantRow {
  const grant: GrantRow = {
    id: randomUUID(),
    address: WALLET_LC,
    userId: USER_ID,
    network: "monad-testnet",
    kind: "vault",
    alertId: randomUUID(),
    thresholdBps: 9_000,
    maxPerAction: 100_000_000n,
    maxTotal: 300_000_000n,
    usedTotal: 0n,
    maxSellDiscountBps: null,
    payMask: null,
    minBidDiscountBps: null,
    payIdx: null,
    expiresAt: NOW + 86_400_000,
    status: "active",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
  new GrantRepository(db).insert(grant);
  return grant;
}
