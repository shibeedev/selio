import { parseAbi } from "viem";

/**
 * Kuru spot order book: the functions, events and errors Selio uses. Hand-written (Kuru's packages are not a
 * dependency); every selector and event topic was checked against the deployed implementations on Monad mainnet and
 * testnet. Events have no indexed fields, and `OrderCanceled` carries the price before the size.
 */
export const kuruOrderBookAbi = parseAbi([
  "function addBuyOrder(uint32 price, uint96 size, bool postOnly)",
  "function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill) returns (uint256)",
  "function batchCancelOrdersNoRevert(uint40[] orderIds)",
  "function batchUpdate(uint32[] buyPrices, uint96[] buySizes, uint32[] sellPrices, uint96[] sellSizes, uint40[] orderIdsToCancel, bool postOnly)",
  "function getMarketParams() view returns (uint32 pricePrecision, uint96 sizePrecision, address base, uint256 baseDecimals, address quote, uint256 quoteDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
  "function s_orders(uint40 orderId) view returns (address owner, uint96 size, uint40 prev, uint40 next, uint40 flippedId, uint32 price, uint32 flippedPrice, bool isBuy)",
  "function s_buyPricePoints(uint256 price) view returns (uint40 head, uint40 tail)",
  "function s_orderIdCounter() view returns (uint40)",
  "function getL2Book(uint32 bidPoints, uint32 askPoints) view returns (bytes)",
  "function bestBidAsk() view returns (uint256 bestBid, uint256 bestAsk)",
  "function marketState() view returns (uint8)",
  "event OrderCreated(uint40 orderId, address owner, uint96 size, uint32 price, bool isBuy)",
  "event OrderCanceled(uint40 orderId, address owner, uint32 price, uint96 size, bool isBuy)",
  "event OrdersCanceled(uint40[] orderIds, address owner)",
  "event Trade(uint40 orderId, address maker, bool isBuy, uint256 price, uint96 updatedSize, address taker, address txOrigin, uint96 filledSize)",
  "error SlippageExceeded()",
  "error SizeError()",
  "error MarketStateError()",
  "error PostOnlyError()",
  "error TickSizeError()",
]);

/** Kuru's margin account, which holds the balances orders trade from. */
export const kuruMarginAccountAbi = parseAbi([
  "function deposit(address user, address token, uint256 amount)",
  "function withdraw(uint256 amount, address token)",
  "function getBalance(address user, address token) view returns (uint256)",
  "error InsufficientBalance()",
  "error ProtocolPaused()",
]);

/** Kuru's market factory. */
export const kuruRouterAbi = parseAbi([
  "function deployProxy(uint8 _type, address base, address quote, uint96 sizePrecision, uint32 pricePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread) returns (address)",
  "function computeAddress(address base, address quote, uint96 sizePrecision, uint32 pricePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread, address oldImplementation, bool old) view returns (address)",
  "function verifiedMarket(address market) view returns (uint32 pricePrecision, uint96 sizePrecision, address base, uint256 baseDecimals, address quote, uint256 quoteDecimals, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps)",
]);

/** Aave static (non-rebasing) aToken wrapper, an ERC-4626 vault whose shares wrap the reserve's aToken. */
export const stataTokenAbi = parseAbi([
  "function depositATokens(uint256 assets, address receiver) returns (uint256)",
  "function redeemATokens(uint256 shares, address receiver, address owner) returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function aToken() view returns (address)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
]);
