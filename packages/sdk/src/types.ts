import type { Address, Hex } from "viem";

export interface SessionParams {
  /** Discount at the start, in basis points. */
  startBps: number;
  /** Discount added every `stepInterval` seconds. */
  stepBps: number;
  stepInterval: number;
  /** Maximum discount the session ever reaches. */
  capBps: number;
  /** Session length in seconds. */
  duration: number;
  /** Bit i set = payment token i accepted. */
  payMask: number;
}

export interface SessionView {
  id: bigint;
  seller: Address;
  startedAt: number;
  endsAt: number;
  startBps: number;
  stepBps: number;
  capBps: number;
  stepInterval: number;
  payMask: number;
  units: bigint;
  discountBps: number;
  remainingAssets: bigint;
  open: boolean;
  acceptedPayTokens: Address[];
}

export interface BidView {
  id: bigint;
  bidder: Address;
  minDiscountBps: number;
  payIdx: number;
  payToken: Address;
  maxAssets: bigint;
  escrow: bigint;
  /** Receipt value this bid can still buy at its own limit discount. */
  capacityAssets: bigint;
}

export interface CapacityView {
  withdrawable: bigint;
  supplied: bigint;
  utilizationBps: number;
  debtorCapacity: bigint;
  sessionAssets: bigint;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** A transaction ready to be signed by the user's wallet. Selio tooling never signs on its own. */
export interface UnsignedTx {
  to: Address;
  data: Hex;
  value: bigint;
  description: string;
}

export interface SellPlan {
  bidIds: bigint[];
  fills: {
    bidId: bigint;
    assets: bigint;
    pay: bigint;
    /** Protocol fee the market takes from `pay`. */
    fee: bigint;
    /** What the seller receives for this fill: `pay − fee`. */
    sellerNet: bigint;
    payToken: Address;
    discountBps: number;
  }[];
  filledAssets: bigint;
  /** Proceeds per payment token. */
  proceeds: Record<Address, bigint>;
  /** Protocol fees per payment token. */
  fees: Record<Address, bigint>;
  /** What the seller receives per payment token, after the protocol fee. */
  sellerNet: Record<Address, bigint>;
  averageDiscountBps: number;
}

/** A seller's view of one quote: what the buyer or the bid pays, the protocol fee, and what the seller receives. */
export interface SellerQuote {
  payment: bigint;
  fee: bigint;
  sellerNet: bigint;
}

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface BorrowerPosition {
  debt: bigint;
  /** Aave health factor (1e18) or Morpho max-borrow over debt (1e18); max uint when no debt. */
  health: bigint;
  /** Morpho only: the market the borrower owes in. */
  market?: MorphoMarketParams;
  marketId?: Hex;
  collateral?: bigint;
}

/** A Kuru order-book market of the receipt (or of its static wrapper) against the underlying. */
export interface KuruMarketInfo {
  book: Address;
  base: TokenInfo;
  quote: TokenInfo;
  /** Aave static aToken traded as the base; the zero address when the book trades the receipt itself. */
  wrapper: Address;
  /** Price units per whole quote unit: a price P pays P / pricePrecision quote per whole base unit. */
  pricePrecision: number;
  /** Size units per whole base unit. */
  sizePrecision: bigint;
  tickSize: number;
  minSize: bigint;
  maxSize: bigint;
  takerFeeBps: number;
  makerFeeBps: number;
}

/** One bid level of the Kuru book, read as a discount below face value. */
export interface KuruLevel {
  /** Price in pricePrecision units. */
  price: number;
  /** Size in sizePrecision units. */
  size: bigint;
  /** Base token amount of `size`. */
  baseAmount: bigint;
  /** Underlying face value of that base. */
  faceAssets: bigint;
  /** Discount of the price below face, in basis points (0 for a premium). */
  discountBps: number;
  /** What the seller receives per unit of face value, net of Kuru's taker fee (1e18 = face). */
  netPerFaceWad: bigint;
}

/** Sell now split between Selio's bids and the Kuru book, each unit of face value to whichever pays the seller more. */
export interface RoutedSellPlan {
  /** The Selio leg: fills of escrowed bids, with Selio's fee. */
  selio: SellPlan;
  /** The Kuru leg, or null when Kuru pays no more than Selio's bids. */
  kuru: {
    /** Receipt amount the router takes for the Kuru leg (Aave: aTokens to wrap; Morpho: face value of the shares). */
    receiptAssets: bigint;
    /** Base sold on Kuru, rounded down to the market's size grain. */
    baseAmount: bigint;
    size: bigint;
    /** Exact Kuru proceeds in the underlying, net of Kuru's taker fee (zero-address quote). */
    expectedOut: bigint;
    /** Least the Kuru leg may pay, or the whole sale reverts: above both the slippage bound and `displacedValue`. */
    minOut: bigint;
    /** Net the seller would get for the same face value from the Selio bids the plan does not use. */
    displacedValue: bigint;
    levels: { price: number; faceAssets: bigint }[];
  } | null;
  /** Face value sold on both venues. */
  filledAssets: bigint;
  route: "selio" | "selio+kuru" | "kuru";
  averageDiscountBps: number;
  /** Underlying value the seller receives: the Selio leg valued at face × (1 − discount) × (1 − fee), plus the Kuru leg. */
  netValue: bigint;
  /** The seller's inputs, which the sale transaction repeats. */
  maxDiscountBps: number;
  payMask: number;
}

/** The Selio Vault's standing Kuru bid and an account's claim on the vault's Kuru position. */
export interface VaultKuruView {
  /** Resting order id; 0 when no order rests (for example filled in full when placed). */
  orderId: bigint;
  price: number;
  /** Discount of the price below the current face value. */
  discountBps: number;
  remainingSize: bigint;
  /** Face value the resting order can still buy. */
  faceAssets: bigint;
  /** Quote the placement committed. */
  escrow: bigint;
  /** Cost of what the order bought since placement, not yet booked. */
  pendingCost: bigint;
  /** The account's claim, deferred by a redemption while Kuru was unreachable; null without one. */
  claimable: {
    /** Fraction of the vault's Kuru position claimed (1e18 = all of it). */
    wad: bigint;
    /** True once Kuru was reachable again and the claim can be paid with claimKuru. */
    resolved: boolean;
    /** What claimKuru pays now, in the vault asset and in receipt tokens (0 until resolved). */
    cash: bigint;
    receipts: bigint;
  } | null;
}
