import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  maxUint256,
  parseSignature,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  aavePoolAbi,
  erc20Abi,
  morphoAbi,
  morphoAdapterAbi,
  selioVaultAbi,
  vaultV2Abi,
} from "./abis/index.js";
import type { Deployment } from "./networks.js";
import type {
  BidView,
  BorrowerPosition,
  CapacityView,
  MorphoMarketParams,
  SellerQuote,
  SellPlan,
  SessionParams,
  SessionView,
  TokenInfo,
  UnsignedTx,
} from "./types.js";

export const BPS = 10_000n;
export const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n;
const VIRTUAL_ASSETS = 1n;
/** Bid ids read per call of the market's paginated active-bid view. */
const BID_PAGE = 100n;

const MARKET_PARAMS_TUPLE = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

const AUTH_TUPLE = {
  type: "tuple",
  components: [
    { name: "authorizer", type: "address" },
    { name: "authorized", type: "address" },
    { name: "isAuthorized", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const SIG_TUPLE = {
  type: "tuple",
  components: [
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
} as const;

const AUTHORIZATION_TYPES = {
  Authorization: [
    { name: "authorizer", type: "address" },
    { name: "authorized", type: "address" },
    { name: "isAuthorized", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const irmAbi = [
  {
    type: "function",
    name: "borrowRateView",
    stateMutability: "view",
    inputs: [
      { name: "marketParams", ...MARKET_PARAMS_TUPLE },
      {
        name: "market",
        type: "tuple",
        components: [
          { name: "totalSupplyAssets", type: "uint128" },
          { name: "totalSupplyShares", type: "uint128" },
          { name: "totalBorrowAssets", type: "uint128" },
          { name: "totalBorrowShares", type: "uint128" },
          { name: "lastUpdate", type: "uint128" },
          { name: "fee", type: "uint128" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

type MorphoMarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

/** Morpho market id: keccak256(abi.encode(marketParams)). */
export function morphoMarketId(mp: MorphoMarketParams): Hex {
  return keccak256(encodeAbiParameters([MARKET_PARAMS_TUPLE], [mp]));
}

/**
 * Read and transaction-building client for one Selio deployment. Every write method returns an
 * unsigned transaction; signing is left to the caller's wallet.
 */
export class SelioClient {
  private tokenCache = new Map<Address, TokenInfo>();
  private morphoMarketCache?: { id: Hex; params: MorphoMarketParams }[];
  private feeBpsCache?: number;

  constructor(
    readonly deployment: Deployment,
    readonly client: PublicClient,
  ) {}

  get market(): Address {
    return this.deployment.market;
  }

  // ---------- Reads ----------

  async token(address: Address): Promise<TokenInfo> {
    const cached = this.tokenCache.get(address);
    if (cached) return cached;
    const [symbol, decimals] = await Promise.all([
      this.client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const info: TokenInfo = { address, symbol, decimals };
    this.tokenCache.set(address, info);
    return info;
  }

  payTokens(): Promise<TokenInfo[]> {
    return Promise.all(this.deployment.payTokens.map((t) => this.token(t)));
  }

  async capacity(): Promise<CapacityView> {
    const c = await this.client.readContract({ address: this.market, abi: aaveExitMarketAbi, functionName: "capacity" });
    return {
      withdrawable: c.withdrawable,
      supplied: c.supplied,
      utilizationBps: Number(c.utilizationBps),
      debtorCapacity: c.debtorCapacity,
      sessionAssets: c.sessionAssets,
    };
  }

  /** Receipt value escrowed bids would buy from a seller who accepts up to `discountBps`. */
  bidCapacityAt(discountBps: number): Promise<bigint> {
    return this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "bidCapacityAt",
      args: [discountBps],
    });
  }

  async session(id: bigint): Promise<SessionView> {
    const market = this.market;
    const [s, discountBps, remainingAssets, open] = await Promise.all([
      this.client.readContract({ address: market, abi: aaveExitMarketAbi, functionName: "sessions", args: [id] }),
      this.client.readContract({ address: market, abi: aaveExitMarketAbi, functionName: "discountOf", args: [id] }),
      this.client.readContract({ address: market, abi: aaveExitMarketAbi, functionName: "remainingAssets", args: [id] }),
      this.client.readContract({ address: market, abi: aaveExitMarketAbi, functionName: "isOpen", args: [id] }),
    ]);
    const [seller, startedAt, endsAt, startBps, stepBps, capBps, payMask, stepInterval, units] = s;
    return {
      id,
      seller,
      startedAt: Number(startedAt),
      endsAt: Number(endsAt),
      startBps,
      stepBps,
      capBps,
      payMask,
      stepInterval,
      units,
      discountBps,
      remainingAssets,
      open,
      acceptedPayTokens: this.deployment.payTokens.filter((_, i) => (payMask >> i) & 1),
    };
  }

  /** All sessions ever opened, newest first. Pass `openOnly` to drop closed or empty ones. */
  async sessions(openOnly = false): Promise<SessionView[]> {
    const next = await this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "nextSessionId",
    });
    const ids: bigint[] = [];
    for (let i = next - 1n; i >= 1n; i--) ids.push(i);
    const all = await Promise.all(ids.map((id) => this.session(id)));
    return openOnly ? all.filter((s) => s.open) : all;
  }

  /** Active escrowed bids, best price for sellers first (lowest discount). */
  async bids(): Promise<BidView[]> {
    const ids: bigint[] = [];
    for (let offset = 0n; ; offset += BID_PAGE) {
      const page = await this.client.readContract({
        address: this.market,
        abi: aaveExitMarketAbi,
        functionName: "activeBidIdsPage",
        args: [offset, BID_PAGE],
      });
      ids.push(...page);
      if (BigInt(page.length) < BID_PAGE) break;
    }
    // A bid removed between two page reads moves another id across pages; list each id once.
    const views = await Promise.all(
      [...new Set(ids)].map(async (id): Promise<BidView> => {
        const [bidder, minDiscountBps, payIdx, maxAssets, escrow] = await this.client.readContract({
          address: this.market,
          abi: aaveExitMarketAbi,
          functionName: "bids",
          args: [id],
        });
        const capacityAssets = await this.client.readContract({
          address: this.market,
          abi: aaveExitMarketAbi,
          functionName: "bidCapacity",
          args: [id, minDiscountBps],
        });
        const payToken = this.deployment.payTokens[payIdx] ?? zeroAddress;
        return { id, bidder, minDiscountBps, payIdx, payToken, maxAssets, escrow, capacityAssets };
      }),
    );
    return views.sort((a, b) => a.minDiscountBps - b.minDiscountBps || Number(a.id - b.id));
  }

  /** What the buyer or the bid pays for receipts worth `assets` at `discountBps`, in `payToken` (rounded up). */
  quote(assets: bigint, discountBps: number, payToken: Address): Promise<bigint> {
    return this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "quote",
      args: [assets, discountBps, payToken],
    });
  }

  /** The market's protocol fee rate in basis points (`FEE_BPS`, a contract constant), read once. */
  async feeBps(): Promise<number> {
    if (this.feeBpsCache === undefined) {
      this.feeBpsCache = await this.client.readContract({
        address: this.market,
        abi: aaveExitMarketAbi,
        functionName: "FEE_BPS",
      });
    }
    return this.feeBpsCache;
  }

  /** Protocol fee the market takes from a fill that pays `payment`: `payment × FEE_BPS / 10,000`, rounded down. */
  async feeOf(payment: bigint): Promise<bigint> {
    return (payment * BigInt(await this.feeBps())) / BPS;
  }

  /** What a buyer or a bid pays for `assets` at `discountBps`, the protocol fee on it, and what the seller receives. */
  async sellerQuote(assets: bigint, discountBps: number, payToken: Address): Promise<SellerQuote> {
    const payment = await this.quote(assets, discountBps, payToken);
    const fee = await this.feeOf(payment);
    return { payment, fee, sellerNet: payment - fee };
  }

  /** The address that receives the protocol fee, fixed at deployment. */
  feeRecipient(): Promise<Address> {
    return this.client.readContract({ address: this.market, abi: aaveExitMarketAbi, functionName: "feeRecipient" });
  }

  balanceOf(token: Address, account: Address): Promise<bigint> {
    return this.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  }

  /** Underlying value of the account's receipts (aToken balance, or vault shares converted). */
  async receiptValueOf(account: Address): Promise<bigint> {
    const balance = await this.balanceOf(this.deployment.receipt, account);
    if (this.deployment.venue === "aave") return balance;
    return this.client.readContract({
      address: this.deployment.receipt,
      abi: vaultV2Abi,
      functionName: "previewRedeem",
      args: [balance],
    });
  }

  /** Converts an underlying amount into the receipt-token amount a seller escrows. */
  async receiptAmountFor(assets: bigint): Promise<bigint> {
    if (this.deployment.venue === "aave") return assets;
    return this.client.readContract({
      address: this.deployment.receipt,
      abi: vaultV2Abi,
      functionName: "previewWithdraw",
      args: [assets],
    });
  }

  /**
   * Aave flash mode pulls this many extra aToken wei to absorb rounding and refunds what is unused.
   * Approve `price + collateralPullMargin(payToken)`. Zero on Morpho.
   */
  async collateralPullMargin(payToken: Address): Promise<bigint> {
    if (this.deployment.venue !== "aave") return 0n;
    return this.client.readContract({
      address: this.market,
      abi: aaveExitMarketAbi,
      functionName: "collateralPullMargin",
      args: [payToken],
    });
  }

  allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
  }

  // ---------- Borrowers ----------

  /** Same-asset debt and health of a borrower; for Morpho, picks the adapter market with the largest debt. */
  async position(account: Address): Promise<BorrowerPosition> {
    const d = this.deployment;
    if (d.venue === "aave") {
      const [debt, data] = await Promise.all([
        this.balanceOf(d.debtToken as Address, account),
        this.client.readContract({
          address: d.aavePool as Address,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [account],
        }),
      ]);
      return { debt, health: data[5] };
    }
    const morpho = d.morpho as Address;
    let best: BorrowerPosition = { debt: 0n, health: maxUint256 };
    for (const { id, params } of await this.morphoMarkets()) {
      const [pos, m] = await Promise.all([
        this.client.readContract({ address: morpho, abi: morphoAbi, functionName: "position", args: [id, account] }),
        this.client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [id] }),
      ]);
      const [, borrowShares, collateral] = pos;
      if (borrowShares === 0n) continue;
      const totalBorrowAssets = await this.expectedTotalBorrow(params, m);
      const totalBorrowShares = m[3];
      // Same rounding as Morpho's toAssetsUp with virtual shares/assets.
      const debt =
        (borrowShares * (totalBorrowAssets + VIRTUAL_ASSETS) + totalBorrowShares + VIRTUAL_SHARES - 1n) /
        (totalBorrowShares + VIRTUAL_SHARES);
      if (debt <= best.debt) continue;
      const price = await this.client.readContract({
        address: params.oracle,
        abi: [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "price",
      });
      const maxBorrow = (((collateral * price) / ORACLE_SCALE) * params.lltv) / WAD;
      best = { debt, health: (maxBorrow * WAD) / debt, market: params, marketId: id, collateral };
    }
    return best;
  }

  /** Morpho markets the Earn vault supplies through its adapter. */
  async morphoMarkets(): Promise<{ id: Hex; params: MorphoMarketParams }[]> {
    if (this.morphoMarketCache) return this.morphoMarketCache;
    const adapter = this.deployment.adapter as Address;
    const n = await this.client.readContract({ address: adapter, abi: morphoAdapterAbi, functionName: "marketIdsLength" });
    const markets: { id: Hex; params: MorphoMarketParams }[] = [];
    for (let i = 0n; i < n; i++) {
      const id = await this.client.readContract({
        address: adapter,
        abi: morphoAdapterAbi,
        functionName: "marketIds",
        args: [i],
      });
      const [loanToken, collateralToken, oracle, irm, lltv] = await this.client.readContract({
        address: this.deployment.morpho as Address,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [id],
      });
      markets.push({ id, params: { loanToken, collateralToken, oracle, irm, lltv } });
    }
    this.morphoMarketCache = markets;
    return markets;
  }

  /** Total borrow including interest accrued since the market's last update (Morpho's expectedMarketBalances). */
  private async expectedTotalBorrow(params: MorphoMarketParams, m: MorphoMarketState): Promise<bigint> {
    const totalBorrowAssets = m[2];
    if (params.irm === zeroAddress || totalBorrowAssets === 0n) return totalBorrowAssets;
    const block = await this.client.getBlock();
    const elapsed = block.timestamp - m[4];
    if (elapsed <= 0n) return totalBorrowAssets;
    const rate = await this.client.readContract({
      address: params.irm,
      abi: irmAbi,
      functionName: "borrowRateView",
      args: [
        params,
        {
          totalSupplyAssets: m[0],
          totalSupplyShares: m[1],
          totalBorrowAssets: m[2],
          totalBorrowShares: m[3],
          lastUpdate: m[4],
          fee: m[5],
        },
      ],
    });
    const first = rate * elapsed;
    const second = (first * first) / (2n * WAD);
    const third = (second * first) / (3n * WAD);
    return totalBorrowAssets + (totalBorrowAssets * (first + second + third)) / WAD;
  }

  /** Venue data for buy calls: empty for Aave; market, forced deallocation flag and optional auth for Morpho. */
  async venueData(account: Address, opts: { force?: boolean; auth?: Hex } = {}): Promise<Hex> {
    if (this.deployment.venue === "aave") return "0x";
    const pos = await this.position(account);
    if (!pos.market) throw new Error("account has no USDC debt in the Earn vault's markets");
    return encodeAbiParameters(
      [MARKET_PARAMS_TUPLE, { type: "bool" }, { type: "bytes" }],
      [pos.market, opts.force ?? false, opts.auth ?? "0x"],
    );
  }

  /**
   * Morpho flash mode: the buyer signs a grant and a revoke (two EIP-712 signatures, no transaction).
   * The market uses the grant to withdraw only the freed collateral and applies the revoke in the same transaction.
   */
  async signMorphoAuthorization(wallet: WalletClient, account: Address, deadlineSeconds = 3600): Promise<Hex> {
    const d = this.deployment;
    if (d.venue !== "morpho") throw new Error("authorization is only needed on Morpho");
    const morpho = d.morpho as Address;
    const nonce = await this.client.readContract({ address: morpho, abi: morphoAbi, functionName: "nonce", args: [account] });
    const chainId = await this.client.getChainId();
    const block = await this.client.getBlock();
    // Forks can run behind or ahead of wall-clock time; count from whichever is later.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = (block.timestamp > now ? block.timestamp : now) + BigInt(deadlineSeconds);
    const grant = { authorizer: account, authorized: d.market, isAuthorized: true, nonce, deadline };
    const revoke = { ...grant, isAuthorized: false, nonce: nonce + 1n };
    // Prefer the wallet's own (local or injected) account; an address alone makes viem ask the RPC node to sign.
    const signer =
      wallet.account && wallet.account.address.toLowerCase() === account.toLowerCase() ? wallet.account : account;
    const sign = async (message: typeof grant) => {
      const signature = await wallet.signTypedData({
        account: signer,
        domain: { chainId, verifyingContract: morpho },
        types: AUTHORIZATION_TYPES,
        primaryType: "Authorization",
        message,
      });
      const { r, s, v, yParity } = parseSignature(signature);
      return { v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s };
    };
    const grantSig = await sign(grant);
    const revokeSig = await sign(revoke);
    return encodeAbiParameters([AUTH_TUPLE, SIG_TUPLE, AUTH_TUPLE, SIG_TUPLE], [grant, grantSig, revoke, revokeSig]);
  }

  // ---------- Planning ----------

  /** Best-price-first plan for selling `assets` into escrowed bids up to `maxDiscountBps`. */
  async planSellNow(assets: bigint, maxDiscountBps: number, payMask: number): Promise<SellPlan> {
    const bids = (await this.bids()).filter(
      (b) => b.minDiscountBps <= maxDiscountBps && ((payMask >> b.payIdx) & 1) === 1 && b.capacityAssets > 0n,
    );
    const plan: SellPlan = {
      bidIds: [],
      fills: [],
      filledAssets: 0n,
      proceeds: {},
      fees: {},
      sellerNet: {},
      averageDiscountBps: 0,
    };
    const feeBps = BigInt(await this.feeBps());
    let weighted = 0n;
    for (const b of bids) {
      if (plan.filledAssets >= assets) break;
      const left = assets - plan.filledAssets;
      const f = b.capacityAssets < left ? b.capacityAssets : left;
      const pay = await this.quote(f, b.minDiscountBps, b.payToken);
      const fee = (pay * feeBps) / BPS;
      const net = pay - fee;
      plan.bidIds.push(b.id);
      plan.fills.push({ bidId: b.id, assets: f, pay, fee, sellerNet: net, payToken: b.payToken, discountBps: b.minDiscountBps });
      plan.filledAssets += f;
      plan.proceeds[b.payToken] = (plan.proceeds[b.payToken] ?? 0n) + pay;
      plan.fees[b.payToken] = (plan.fees[b.payToken] ?? 0n) + fee;
      plan.sellerNet[b.payToken] = (plan.sellerNet[b.payToken] ?? 0n) + net;
      weighted += f * BigInt(b.minDiscountBps);
    }
    plan.averageDiscountBps = plan.filledAssets === 0n ? 0 : Number(weighted / plan.filledAssets);
    return plan;
  }

  /** Largest purchase a borrower can make from a session: the smaller of what is left and their debt. */
  async maxBuy(sessionId: bigint, account: Address): Promise<bigint> {
    const [s, p] = await Promise.all([this.session(sessionId), this.position(account)]);
    return s.remainingAssets < p.debt ? s.remainingAssets : p.debt;
  }

  // ---------- Tx builders ----------

  approve(token: Address, spender: Address, amount: bigint = maxUint256): UnsignedTx {
    return this.tx(
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
      `Approve ${spender} to spend token ${token}`,
    );
  }

  openSession(receiptAmount: bigint, p: SessionParams): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "openSession", args: [receiptAmount, p] }),
      "Escrow receipts and open a Dutch-auction exit session",
    );
  }

  withdrawUnsold(sessionId: bigint, units: bigint = maxUint256): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "withdrawUnsold", args: [sessionId, units] }),
      "Take back unsold receipts from a session",
    );
  }

  buyAndRepay(sessionId: bigint, assets: bigint, payIdx: number, maxPay: bigint, venueData: Hex): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "buyAndRepay",
        args: [sessionId, assets, payIdx, maxPay, venueData],
      }),
      "Buy receipts at the current discount; the market repays your debt in the same transaction",
    );
  }

  buyAndRepayWithCollateral(sessionId: bigint, assets: bigint, payIdx: number, maxPay: bigint, venueData: Hex): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "buyAndRepayWithCollateral",
        args: [sessionId, assets, payIdx, maxPay, venueData],
      }),
      "Flash mode: repay debt first, then pay the seller with the collateral that frees up",
    );
  }

  placeBid(minDiscountBps: number, payIdx: number, maxAssets: bigint, escrow: bigint): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "placeBid",
        args: [minDiscountBps, payIdx, maxAssets, escrow],
      }),
      "Escrow funds and place a limit bid for receipts",
    );
  }

  cancelBid(bidId: bigint): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "cancelBid", args: [bidId] }),
      "Cancel a limit bid and get unused escrow back immediately",
    );
  }

  sellNow(plan: SellPlan, maxDiscountBps: number, payMask: number, minFilled: bigint): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({
        abi: aaveExitMarketAbi,
        functionName: "sellNow",
        args: [plan.filledAssets, plan.bidIds, maxDiscountBps, payMask, minFilled],
      }),
      "Sell receipts now into escrowed bids, best price first",
    );
  }

  matchBid(sessionId: bigint, bidId: bigint, assets: bigint = maxUint256): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "matchBid", args: [sessionId, bidId, assets] }),
      "Fill a limit bid from a session whose discount has reached it",
    );
  }

  redeemReceipt(assets: bigint, to: Address): UnsignedTx {
    return this.tx(
      this.market,
      encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "redeemReceipt", args: [assets, to] }),
      "Redeem receipts for the underlying once the pool is liquid",
    );
  }

  // ---------- Vault ----------

  /**
   * State of the Selio Vault (strategy 0), its base-yield source, and, with an account, what redeeming all of the
   * account's shares would pay now and in kind.
   */
  async vaultState(account?: Address) {
    const v = this.deployment.selioVault;
    const [totalAssets, idleAssets, heldAssets, totalSupply, decimals, bidId, yieldSource] = await Promise.all([
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "totalAssets" }),
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "idleAssets" }),
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "heldAssets", args: [0n] }),
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "totalSupply" }),
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "decimals" }),
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "bidOf", args: [0n] }),
      this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "yieldSource" }),
    ]);
    const strategy = await this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "strategy", args: [0n] });
    let sourceSymbol = "";
    let sourceShares = 0n;
    let sourceAssets = 0n;
    let sourceUtilizationBps = 0;
    if (yieldSource !== zeroAddress) {
      const [info, shares, assets, utilizationBps] = await Promise.all([
        this.token(yieldSource),
        this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "sourceShares" }),
        this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "sourceAssets" }),
        this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "sourceUtilizationBps" }),
      ]);
      sourceSymbol = info.symbol;
      sourceShares = shares;
      sourceAssets = assets;
      sourceUtilizationBps = Number(utilizationBps);
    }
    let shares = 0n;
    let preview: readonly [bigint, readonly bigint[], bigint] = [0n, [], 0n];
    if (account) {
      shares = await this.balanceOf(v, account);
      preview = await this.client.readContract({ address: v, abi: selioVaultAbi, functionName: "previewRedeem", args: [shares] });
    }
    return {
      totalAssets,
      idleAssets,
      heldAssets,
      totalSupply,
      decimals,
      bidId,
      minDiscountBps: strategy.minDiscountBps,
      maxShareBps: strategy.maxShareBps,
      shares,
      redeemNow: preview[0],
      redeemInKind: preview[1][0] ?? 0n,
      /** ERC-4626 vault that earns base yield on capital beyond bid escrow; the zero address when there is none. */
      yieldSource,
      sourceSymbol,
      sourceShares,
      sourceAssets,
      sourceUtilizationBps,
      /** Source shares the redemption would pay in kind because the source cannot pay them now. */
      redeemSourceInKind: preview[2],
    };
  }

  /** Shares a deposit of `assets` would mint now; pass it, or a little less, as `vaultDeposit`'s `minShares`. */
  vaultPreviewDeposit(assets: bigint): Promise<bigint> {
    return this.client.readContract({
      address: this.deployment.selioVault,
      abi: selioVaultAbi,
      functionName: "previewDeposit",
      args: [assets],
    });
  }

  vaultDeposit(assets: bigint, receiver: Address, minShares: bigint): UnsignedTx {
    return this.tx(
      this.deployment.selioVault,
      encodeFunctionData({ abi: selioVaultAbi, functionName: "deposit", args: [assets, receiver, minShares] }),
      "Deposit into the Selio Vault",
    );
  }

  /** `skip` lists receipt tokens to leave in the vault; their share stays claimable later by `owner`. */
  vaultRedeem(shares: bigint, receiver: Address, owner: Address, skip: Address[] = []): UnsignedTx {
    const strategies = skip.map((receipt) => this.strategyOf(receipt));
    return this.tx(
      this.deployment.selioVault,
      encodeFunctionData({ abi: selioVaultAbi, functionName: "redeem", args: [shares, receiver, owner, strategies] }),
      "Redeem vault shares: idle capital now, held receipts in kind",
    );
  }

  vaultRecover(strategy = 0n, assets: bigint = maxUint256): UnsignedTx {
    return this.tx(
      this.deployment.selioVault,
      encodeFunctionData({ abi: selioVaultAbi, functionName: "recover", args: [strategy, assets] }),
      "Redeem receipts held by the vault now that the pool is liquid",
    );
  }

  /** Strategy index of a receipt in the Selio Vault, whose only strategy is this deployment's market. */
  private strategyOf(receipt: Address): bigint {
    if (receipt.toLowerCase() !== this.deployment.receipt.toLowerCase()) {
      throw new Error(`${receipt} is not a receipt the Selio Vault holds`);
    }
    return 0n;
  }

  // ---------- Borrower route ----------

  routeRepayWithFrozenCollateral(
    collateralAmount: bigint,
    plan: SellPlan,
    maxDiscountBps: number,
    payIdx: number,
    repayAmount: bigint,
    minProceeds: bigint,
  ): UnsignedTx {
    return this.tx(
      this.requireRoute(),
      encodeFunctionData({
        abi: aaveCollateralRouteAbi,
        functionName: "repayWithFrozenCollateral",
        args: [this.market, collateralAmount, plan.bidIds, maxDiscountBps, payIdx, repayAmount, minProceeds],
      }),
      "Repay debt by selling frozen collateral into bids (no withdrawal needed)",
    );
  }

  routeSwapFrozenCollateral(
    collateralAmount: bigint,
    plan: SellPlan,
    maxDiscountBps: number,
    payIdx: number,
    minProceeds: bigint,
  ): UnsignedTx {
    return this.tx(
      this.requireRoute(),
      encodeFunctionData({
        abi: aaveCollateralRouteAbi,
        functionName: "swapFrozenCollateral",
        args: [this.market, collateralAmount, plan.bidIds, maxDiscountBps, payIdx, minProceeds],
      }),
      "Swap frozen collateral for new collateral by selling it into bids",
    );
  }

  // ---------- Simulation ----------

  /** Dry-runs an unsigned transaction from `account`; resolves on success, throws the revert reason otherwise. */
  async simulate(tx: UnsignedTx, account: Address): Promise<void> {
    await this.client.call({ account, to: tx.to, data: tx.data, value: tx.value });
  }

  private tx(to: Address, data: Hex, description: string): UnsignedTx {
    return { to, data, value: 0n, description };
  }

  private requireRoute(): Address {
    const route = this.deployment.collateralRoute;
    if (!route) throw new Error("the frozen-collateral route exists on Aave networks only");
    return route;
  }
}
