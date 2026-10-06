// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ExitMarket} from "../market/ExitMarket.sol";
import {IStataToken} from "../shared/interfaces/IStataToken.sol";
import {KuruMarketParams} from "../shared/interfaces/IKuru.sol";

/// @title KuruMath
/// @notice Conversions between a Kuru market's prices and sizes and the face value of the receipt it trades, shared
/// by the Selio Vault and `KuruSellRouter`.
/// @dev `face` is the underlying value of one whole base unit (`10^baseDecimals`) in underlying wei. The quote is
/// always the receipt's underlying, so no oracle is involved. A price `P` (`pricePrecision` units) pays
/// `P × 10^quoteDecimals / pricePrecision` quote wei per whole base unit; a size `S` is `S × 10^baseDecimals /
/// sizePrecision` base wei.
library KuruMath {
    uint256 internal constant BPS = 10_000;

    /// @notice Underlying wei per whole base unit: the wrapper's assets per share (Aave static aToken), else the
    /// market's value of one receipt unit (Morpho Vault V2 share).
    function facePerBase(ExitMarket market, IStataToken wrapper, uint256 baseDecimals) internal view returns (uint256) {
        uint256 one = 10 ** baseDecimals;
        return address(wrapper) != address(0) ? wrapper.convertToAssets(one) : market.receiptValue(one);
    }

    /// @notice Price at par: `⌊face × pricePrecision / 10^quoteDecimals⌋`.
    function parPrice(uint256 face, KuruMarketParams memory m) internal pure returns (uint256) {
        return Math.mulDiv(face, m.pricePrecision, 10 ** m.quoteDecimals);
    }

    /// @notice Discount of `price` below face in basis points, rounded down; 0 for a price at or above par.
    function discountOf(uint256 price, uint256 face, KuruMarketParams memory m) internal pure returns (uint256) {
        uint256 faceScaled = face * m.pricePrecision;
        uint256 paid = price * 10 ** m.quoteDecimals;
        if (paid >= faceScaled) return 0;
        return Math.mulDiv(faceScaled - paid, BPS, faceScaled);
    }

    /// @notice Highest tick price that never pays more than `discountBps` below face.
    function priceForDiscount(uint256 discountBps, uint256 face, KuruMarketParams memory m)
        internal
        pure
        returns (uint256)
    {
        uint256 exact = Math.mulDiv(face * m.pricePrecision, BPS - discountBps, 10 ** m.quoteDecimals * BPS);
        return tickFloor(exact, m.tickSize);
    }

    /// @notice The Selio Vault's price: at least `minDiscountBps` below face net of the market's taker fee, which the
    /// vault's order pays where it crosses resting asks.
    function vaultPrice(uint256 face, uint256 minDiscountBps, KuruMarketParams memory m) internal pure returns (uint256) {
        uint256 exact = Math.mulDiv(
            face * m.pricePrecision, (BPS - minDiscountBps) * (BPS - m.takerFeeBps), 10 ** m.quoteDecimals * BPS * BPS
        );
        return tickFloor(exact, m.tickSize);
    }

    function tickFloor(uint256 price, uint256 tickSize) internal pure returns (uint256) {
        return price - price % tickSize;
    }

    /// @notice Quote Kuru debits from the margin account for a buy order of `size` at `price`:
    /// `⌈price × size / sizePrecision⌉ × 10^quoteDecimals / pricePrecision`.
    function debit(uint256 price, uint256 size, KuruMarketParams memory m) internal pure returns (uint256) {
        return Math.ceilDiv(price * size, m.sizePrecision) * 10 ** m.quoteDecimals / m.pricePrecision;
    }

    /// @notice Quote Kuru credits back when it cancels `size` resting at `price`:
    /// `⌊⌊size × price / sizePrecision⌋ × 10^quoteDecimals / pricePrecision⌋`.
    function refundValue(uint256 size, uint256 price, KuruMarketParams memory m) internal pure returns (uint256) {
        return size * price / m.sizePrecision * 10 ** m.quoteDecimals / m.pricePrecision;
    }

    /// @notice Largest order size at `price` whose debit stays within `budget` (quote wei) and whose face value stays
    /// within `room` (underlying wei), capped at the market's `maxSize`.
    function sizeFor(uint256 price, uint256 face, uint256 budget, uint256 room, KuruMarketParams memory m)
        internal
        pure
        returns (uint256 size)
    {
        uint256 quoteUnit = 10 ** m.quoteDecimals;
        size = Math.mulDiv(budget * m.pricePrecision, m.sizePrecision, price * quoteUnit);
        uint256 byRoom = Math.mulDiv(room, m.sizePrecision, face);
        if (byRoom < size) size = byRoom;
        if (m.maxSize < size) size = m.maxSize;
        if (debit(price, size, m) > budget) {
            // The debit rounds up: the largest size with `⌈price × size / sizePrecision⌉ ≤ cMax` fits the budget.
            uint256 cMax = ((budget + 1) * m.pricePrecision - 1) / quoteUnit;
            uint256 fits = Math.mulDiv(cMax, m.sizePrecision, price);
            if (fits < size) size = fits;
        }
    }

    /// @notice Base wei of `size` size units.
    function baseAmount(uint256 size, KuruMarketParams memory m) internal pure returns (uint256) {
        return size * 10 ** m.baseDecimals / m.sizePrecision;
    }
}
