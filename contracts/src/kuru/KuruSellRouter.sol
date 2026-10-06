// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ExitMarket} from "../market/ExitMarket.sol";
import {IKuruOrderBook, KuruMarketParams} from "../shared/interfaces/IKuru.sol";
import {IStataToken} from "../shared/interfaces/IStataToken.sol";
import {KuruMath} from "./KuruMath.sol";

/// @title KuruSellRouter
/// @notice Sells deposit receipts now across Selio's bids and the Kuru order book of the same receipt, in one
/// transaction: the Selio leg through the exit market's `sellNow` (Selio's 0.2% fee), the Kuru leg as a market sell
/// that pays only the Kuru market's own taker fee (an Aave receipt is first wrapped into the static aToken the book
/// trades). Either leg failing reverts both. Also publishes the market's exit capacity as the risk data of the Kuru
/// market.
/// @dev No owner, no admin function and no fee. Everything left at the end of a sale (pay tokens, unsold receipts,
/// unsold base, unwrapped where possible) goes back to the seller's `to` in the same call.
contract KuruSellRouter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice A routed sale: `selioAssets` of receipt value into the listed Selio bids, `kuruAssets` into the Kuru
    /// book for at least `kuruMinOut` of the underlying. `to == address(0)` means the caller.
    struct SellOrder {
        uint256 selioAssets;
        uint256[] bidIds;
        uint16 maxDiscountBps;
        uint8 payMask;
        uint256 selioMinFilled;
        uint256 kuruAssets;
        uint256 kuruMinOut;
        address to;
    }

    ExitMarket public immutable market;
    IKuruOrderBook public immutable book;
    /// @notice Aave static aToken traded on the book for an Aave receipt; `address(0)` when the book trades the
    /// receipt itself (Morpho Vault V2 shares).
    IStataToken public immutable wrapper;
    IERC20 public immutable receipt;
    /// @notice Token the book sells: `wrapper` when set, else `receipt`.
    IERC20 public immutable base;
    /// @notice Token the book pays: the market's underlying.
    IERC20 public immutable quote;

    event KuruRoutedSale(
        address indexed seller,
        address indexed to,
        uint256 selioAssets,
        uint256 selioFilled,
        uint256 kuruAssets,
        uint256 kuruBase,
        uint256 kuruOut
    );

    error ZeroAmount();
    error BadParams();

    constructor(ExitMarket market_, IKuruOrderBook book_, IStataToken wrapper_) {
        KuruMarketParams memory p = book_.getMarketParams();
        IERC20 receipt_ = market_.receipt();
        address base_ = address(wrapper_) != address(0) ? address(wrapper_) : address(receipt_);
        if (p.base != base_ || p.quote != market_.underlying()) revert BadParams();
        if (address(wrapper_) != address(0) && wrapper_.aToken() != address(receipt_)) revert BadParams();
        market = market_;
        book = book_;
        wrapper = wrapper_;
        receipt = receipt_;
        base = IERC20(base_);
        quote = IERC20(p.quote);
    }

    /// @notice Sells the caller's receipts on both venues. Returns the Selio leg's receipt value sold, the whole
    /// payment of each Selio fill (the seller receives it minus Selio's fee), and the Kuru leg's underlying proceeds,
    /// net of Kuru's taker fee.
    function sell(SellOrder calldata o)
        external
        nonReentrant
        returns (uint256 selioFilled, uint256[] memory selioPaid, uint256 kuruOut)
    {
        uint256 total = o.selioAssets + o.kuruAssets;
        if (total == 0) revert ZeroAmount();
        address to = o.to == address(0) ? msg.sender : o.to;
        bool aave = address(wrapper) != address(0);
        // Aave: aToken amounts are values (a transfer can arrive 1 wei short, so later steps use balances). Morpho:
        // the shares worth `total`.
        receipt.safeTransferFrom(
            msg.sender, address(this), aave ? total : IERC4626(address(receipt)).previewWithdraw(total)
        );
        if (o.selioAssets > 0) {
            receipt.forceApprove(address(market), receipt.balanceOf(address(this)));
            (selioFilled, selioPaid) =
                market.sellNow(o.selioAssets, o.bidIds, o.maxDiscountBps, o.payMask, o.selioMinFilled);
            receipt.forceApprove(address(market), 0);
        }
        uint256 kuruBase;
        if (o.kuruAssets > 0) (kuruBase, kuruOut) = _sellOnKuru(o.kuruAssets, o.kuruMinOut, aave);
        _sendBack(to, aave);
        emit KuruRoutedSale(msg.sender, to, o.selioAssets, selioFilled, o.kuruAssets, kuruBase, kuruOut);
    }

    /// @notice Underlying wei per whole base unit, to translate Kuru prices into discounts.
    function facePerBase() external view returns (uint256) {
        return KuruMath.facePerBase(market, wrapper, book.getMarketParams().baseDecimals);
    }

    /// @notice Exit capacity of the pool behind every receipt this Kuru market trades.
    function exitCapacity() external view returns (ExitMarket.Capacity memory) {
        return market.capacity();
    }

    /// @dev Market-sells the base worth `assets` of receipt value (wrapping Aave receipts first), rounded down to the
    /// market's size grain; returns the base the book took and the underlying it paid.
    function _sellOnKuru(uint256 assets, uint256 minOut, bool aave) internal returns (uint256 sold, uint256 out) {
        uint256 amount;
        uint256 held = receipt.balanceOf(address(this));
        if (aave) {
            uint256 a = assets < held ? assets : held;
            receipt.forceApprove(address(wrapper), a);
            amount = wrapper.depositATokens(a, address(this));
        } else {
            uint256 shares = IERC4626(address(receipt)).previewWithdraw(assets);
            amount = shares < held ? shares : held;
        }
        KuruMarketParams memory p = book.getMarketParams();
        uint256 size = amount * p.sizePrecision / 10 ** p.baseDecimals;
        if (size == 0) revert ZeroAmount();
        uint256 before = base.balanceOf(address(this));
        base.forceApprove(address(book), KuruMath.baseAmount(size, p));
        out = book.placeAndExecuteMarketSell(SafeCast.toUint96(size), minOut, false, false);
        base.forceApprove(address(book), 0);
        sold = before - base.balanceOf(address(this));
    }

    /// @dev Sends every pay token, the underlying, the unsold base (unwrapped to the receipt when that yields at least
    /// one wei) and the unsold receipts to `to`.
    function _sendBack(address to, bool aave) internal {
        address[] memory tokens = market.payTokens();
        for (uint256 i; i < tokens.length; ++i) {
            _sweep(IERC20(tokens[i]), to);
        }
        _sweep(quote, to);
        if (aave) {
            uint256 rest = base.balanceOf(address(this));
            if (rest > 0) {
                if (wrapper.convertToAssets(rest) > 0) wrapper.redeemATokens(rest, to, address(this));
                else base.safeTransfer(to, rest);
            }
        }
        _sweep(receipt, to);
    }

    function _sweep(IERC20 token, address to) internal {
        uint256 balance = token.balanceOf(address(this));
        if (balance > 0) token.safeTransfer(to, balance);
    }
}
