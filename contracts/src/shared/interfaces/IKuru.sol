// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Configuration of a Kuru order-book market, as `getMarketParams()` and the Router's `verifiedMarket` return
/// it. Prices are in `pricePrecision` units of quote per whole base unit, sizes in `sizePrecision` units of base.
struct KuruMarketParams {
    uint32 pricePrecision;
    uint96 sizePrecision;
    address base;
    uint256 baseDecimals;
    address quote;
    uint256 quoteDecimals;
    uint32 tickSize;
    uint96 minSize;
    uint96 maxSize;
    uint256 takerFeeBps;
    uint256 makerFeeBps;
}

/// @notice Minimal subset of a Kuru spot order book used by Selio.
interface IKuruOrderBook {
    function addBuyOrder(uint32 price, uint96 size, bool postOnly) external;
    function placeAndExecuteMarketSell(uint96 size, uint256 minAmountOut, bool isMargin, bool isFillOrKill)
        external
        returns (uint256);
    function batchCancelOrdersNoRevert(uint40[] calldata orderIds) external;
    function getMarketParams() external view returns (KuruMarketParams memory);
    function s_orders(uint40 orderId)
        external
        view
        returns (
            address owner,
            uint96 size,
            uint40 prev,
            uint40 next,
            uint40 flippedId,
            uint32 price,
            uint32 flippedPrice,
            bool isBuy
        );
    function s_buyPricePoints(uint256 price) external view returns (uint40 head, uint40 tail);
    function s_orderIdCounter() external view returns (uint40);
    function getL2Book(uint32 bidPoints, uint32 askPoints) external view returns (bytes memory);
    function bestBidAsk() external view returns (uint256, uint256);
    function marketState() external view returns (uint8);
}

/// @notice Minimal subset of Kuru's margin account used by Selio.
interface IKuruMarginAccount {
    function deposit(address user, address token, uint256 amount) external;
    function withdraw(uint256 amount, address token) external;
    function getBalance(address user, address token) external view returns (uint256);
}

/// @notice Minimal subset of Kuru's market factory used by Selio's deployment.
interface IKuruRouter {
    function deployProxy(
        uint8 _type,
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 kuruAmmSpread
    ) external returns (address);
    function computeAddress(
        address base,
        address quote,
        uint96 sizePrecision,
        uint32 pricePrecision,
        uint32 tickSize,
        uint96 minSize,
        uint96 maxSize,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint96 kuruAmmSpread,
        address oldImplementation,
        bool old
    ) external view returns (address);
    function verifiedMarket(address market) external view returns (KuruMarketParams memory);
}
