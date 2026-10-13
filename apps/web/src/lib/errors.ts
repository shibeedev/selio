import { decodeErrorResult, type Abi, type Hex } from "viem";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  kuruMarginAccountAbi,
  kuruOrderBookAbi,
  kuruSellRouterAbi,
  morphoVaultExitMarketAbi,
  priceRouterAbi,
  selioVaultAbi,
  testTokenAbi,
} from "@selio/sdk";

/** Every custom error of the market, vault, route, price router, test token, Kuru router and Kuru ABIs. */
const ERROR_ABI = [
  aaveExitMarketAbi,
  morphoVaultExitMarketAbi,
  selioVaultAbi,
  aaveCollateralRouteAbi,
  priceRouterAbi,
  testTokenAbi,
  kuruSellRouterAbi,
  kuruOrderBookAbi,
  kuruMarginAccountAbi,
].flatMap((abi) => (abi as Abi).filter((item) => item.type === "error")) as Abi;

const MESSAGES: Record<string, string> = {
  ZeroAmount: "The amount is zero.",
  BadParams: "Some parameters are out of range.",
  NotSeller: "Only the seller of this auction can do that.",
  NotBidder: "Only the bidder can cancel this bid.",
  SessionClosed: "This auction has ended or sold out.",
  PayTokenNotAccepted: "The seller does not accept this payment asset.",
  PriceTooHigh: "The price is above your limit. Refresh and try again.",
  DebtTooSmall: "Your same-asset debt is smaller than the amount you are buying.",
  NotEnoughUnits: "The auction has less left than that amount.",
  DiscountBelowBid: "The auction's discount has not reached this bid's minimum yet.",
  UnknownBid: "That bid no longer exists.",
  InsufficientFill: "The bids changed since the preview, so less would sell than shown. Refresh and try again.",
  HealthDecreased: "Your health factor would go down, so the market refused.",
  SamePaymentAsset: "Flash mode cannot pay in the receipt's own asset.",
  EscrowTouched: "That would touch receipts escrowed in auctions.",
  NoFlashLiquidity: "No flash liquidity is available to repay on your behalf right now.",
  FlashLiquidityTooLow: "Flash liquidity is too low for this size. Try a smaller amount.",
  UnexpectedCallback: "Unexpected flash-loan callback.",
  NoCollateralToken: "This payment asset cannot be paid from Aave collateral.",
  WrongMarket: "Your debt or collateral is not in a market this vault supplies.",
  BadAuthorization: "The Morpho permission signatures are missing or invalid.",
  AuthorizationNotRevoked: "The Morpho permission was not revoked.",
  ProceedsTooLow: "The sale would not raise enough. Sell more collateral or ask for less.",
  ZeroShares: "That amount is too small to mint or redeem a vault share.",
  FeedMissing: "There is no price feed for this asset.",
  BadPrice: "The price feed returned an invalid price.",
  StalePrice: "The price feed is stale, so pricing is paused.",
  ERC20InsufficientBalance: "Your token balance is too low.",
  ERC20InsufficientAllowance: "The token allowance is too low.",
  SafeERC20FailedOperation: "A token transfer failed.",
  ReentrancyGuardReentrantCall: "Reentrant call blocked.",
  MintLimit: "The test token mint limit is reached.",
  BidTooSmall: "The bid is below the market's minimum size, so it could never fill. Escrow more.",
  InsufficientShares: "The deposit would mint fewer vault shares than the preview allows. Refresh and try again.",
  UnknownMarket: "The route works only with the Selio markets it was deployed with.",
  SourceNotTight: "The yield source is below 90% utilization, so nothing needs to be pulled back.",
  NotSelf: "Only the Selio Vault itself can run that step.",
  NothingToClaim: "There is nothing to claim yet: Kuru has not been reachable since your share was set aside.",
  SlippageExceeded: "Kuru would pay less than the sale's minimum now. Refresh the preview, or sell on Selio only.",
  SizeError: "That size is outside what the Kuru market accepts per order.",
  MarketStateError: "The Kuru market is paused right now.",
  PostOnlyError: "That bid would buy at once from a Kuru ask; a limit bid only rests in the book. Lower the price.",
  TickSizeError: "That price is not on the Kuru market's price grid.",
  InsufficientBalance: "Your Kuru margin account holds less than that.",
  ProtocolPaused: "Kuru is paused right now, including withdrawals from its margin account.",
};

const PANICS: Record<number, string> = {
  1: "assertion failed",
  17: "arithmetic overflow or underflow",
  18: "division by zero",
  50: "array index out of bounds",
};

const MAX_DEPTH = 12;

function* causeChain(err: unknown): Generator<Record<string, unknown>> {
  let current = err;
  for (let depth = 0; depth < MAX_DEPTH && current !== null && typeof current === "object"; depth++) {
    const level = current as Record<string, unknown>;
    yield level;
    current = level.cause;
  }
}

const isRevertHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);

/** First revert data in the cause chain, also one level into `data.data`. */
export function extractRevertData(err: unknown): Hex | undefined {
  for (const level of causeChain(err)) {
    if (isRevertHex(level.data)) return level.data;
    const inner = level.data;
    if (inner && typeof inner === "object" && isRevertHex((inner as { data?: unknown }).data)) {
      return (inner as { data: Hex }).data;
    }
  }
  return undefined;
}

export function describeRevertData(data: Hex): string | null {
  let decoded: { errorName: string; args?: readonly unknown[] };
  try {
    decoded = decodeErrorResult({ abi: ERROR_ABI, data }) as { errorName: string; args?: readonly unknown[] };
  } catch {
    return null;
  }
  const { errorName, args } = decoded;
  if (errorName === "Error") {
    const reason = String(args?.[0] ?? "");
    return /^\d+$/.test(reason) ? `Aave rejected the call (Aave error code ${reason}).` : reason;
  }
  if (errorName === "Panic") {
    const code = Number(args?.[0] ?? 0);
    return `The contract panicked: ${PANICS[code] ?? `code ${code}`}.`;
  }
  return MESSAGES[errorName] ?? `The contract reverted with ${errorName}.`;
}

function isRejection(err: unknown): boolean {
  for (const level of causeChain(err)) {
    if (level.code === 4001 || level.name === "UserRejectedRequestError") return true;
  }
  return false;
}

/** A fork whose upstream RPC pruned the fork-block state cannot read accounts it has not touched. */
export function isForkStateError(err: unknown): boolean {
  const text: string[] = [];
  for (const level of causeChain(err)) {
    for (const key of ["details", "shortMessage", "message"]) {
      const v = level[key];
      if (typeof v === "string") text.push(v);
    }
  }
  return /historical state .* is not available|failed to get (storage|account|block) for/i.test(text.join(" "));
}

const FORK_STATE_MESSAGE =
  "This fork cannot load state it has not touched yet, because its upstream RPC no longer serves the fork block or is offline. Demo funds from the faucet make your address readable; otherwise restart the fork from an archive RPC.";

export function describeError(err: unknown): string {
  if (isRejection(err)) return "You rejected the request in your wallet.";
  if (isForkStateError(err)) return FORK_STATE_MESSAGE;
  const data = extractRevertData(err);
  if (data) {
    const text = describeRevertData(data);
    if (text) return text;
  }
  if (err === null || typeof err !== "object") return String(err);
  const { shortMessage, details, message } = err as Record<string, unknown>;
  if (typeof shortMessage === "string" && shortMessage) {
    return typeof details === "string" && details && !shortMessage.includes(details)
      ? `${shortMessage} ${details}`
      : shortMessage;
  }
  const text = typeof message === "string" ? message : String(err);
  return text.split("\n")[0] ?? text;
}
