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
