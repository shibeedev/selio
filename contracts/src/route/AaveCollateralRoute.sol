// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AaveExitMarket} from "../venues/aave/AaveExitMarket.sol";
import {IAavePool, IFlashLoanSimpleReceiver} from "../shared/interfaces/IAaveV3.sol";

/// @notice Fallback for Aave borrowers whose collateral sits in a pool that cannot be withdrawn from: sell the
/// collateral aToken into escrowed bids on the exit market instead of withdrawing it, then repay debt or post the
/// proceeds as new collateral, in one transaction.
/// @notice The caller approves this route for their collateral aToken. The route only ever acts for msg.sender, and
/// only on the Selio markets it was deployed with.
contract AaveCollateralRoute is IFlashLoanSimpleReceiver, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant VARIABLE_RATE = 2;
    uint256 internal constant RAY = 1e27;
    uint256 internal constant BPS = 10_000;

    IAavePool public immutable pool;

    uint256[] private ctxBidIds;
    /// @notice True exactly for the markets given at deployment.
    mapping(address => bool) public isMarket;

    address private transient ctxUser;
    address private transient ctxMarket;
    uint256 private transient ctxAmount;
    uint8 private transient ctxPayIdx;
    uint16 private transient ctxMaxDiscount;
    bool private transient ctxActive;
    uint256 private transient ctxMinProceeds;

    event CollateralSoldForRepay(
        address indexed user, address indexed market, uint256 collateralSold, address debtAsset, uint256 repaid
    );
    event CollateralSwapped(
        address indexed user, address indexed market, uint256 collateralSold, address newCollateral, uint256 supplied
    );

    error ZeroAmount();
    error UnexpectedCallback();
    error ProceedsTooLow(uint256 proceeds, uint256 needed);
    error UnknownMarket();

    constructor(IAavePool pool_, AaveExitMarket[] memory markets_) {
        pool = pool_;
        for (uint256 i; i < markets_.length; ++i) {
            isMarket[address(markets_[i])] = true;
        }
    }

    /// @notice Repays `repayAmount` of the caller's variable debt in `market.payTokens()[payIdx]` with an Aave flash
    /// loan, then sells only as much of the offered collateral as the flash amount plus premium needs, net of the
    /// market's fee, into bids paying in that token. Returns unsold collateral and surplus proceeds.
    /// @dev Repays first with an Aave flash loan of `debtAsset`, so the health factor never dips mid-way.
    function repayWithFrozenCollateral(
        AaveExitMarket market,
        uint256 collateralAmount,
        uint256[] calldata bidIds,
        uint16 maxDiscountBps,
        uint8 payIdx,
        uint256 repayAmount,
        uint256 minProceeds
    ) external nonReentrant returns (uint256 sold) {
        if (!isMarket[address(market)]) revert UnknownMarket();
        if (collateralAmount == 0 || repayAmount == 0) revert ZeroAmount();
        address debtAsset = market.payTokens()[payIdx];
        IERC20 collateral = market.receipt();
        ctxUser = msg.sender;
        ctxMarket = address(market);
        ctxAmount = collateralAmount;
        ctxPayIdx = payIdx;
        ctxMaxDiscount = maxDiscountBps;
        ctxMinProceeds = minProceeds;
        ctxActive = true;
        ctxBidIds = bidIds;
        uint256 before = collateral.balanceOf(address(this));
        pool.flashLoanSimple(address(this), debtAsset, repayAmount, "", 0);
        ctxActive = false;
        delete ctxBidIds;
        sold = _returnUnsold(collateral, before, collateralAmount);
        uint256 surplus = IERC20(debtAsset).balanceOf(address(this));
        if (surplus > 0) IERC20(debtAsset).safeTransfer(msg.sender, surplus);
        emit CollateralSoldForRepay(msg.sender, address(market), sold, debtAsset, repayAmount);
    }

    /// @notice Aave flash callback of `repayWithFrozenCollateral`.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata)
        external
        returns (bool)
    {
        if (msg.sender != address(pool) || initiator != address(this) || !ctxActive) revert UnexpectedCallback();
        uint256 owed = amount + premium;
        IERC20(asset).forceApprove(address(pool), owed);
        pool.repay(asset, amount, VARIABLE_RATE, ctxUser);
        uint256 balance = IERC20(asset).balanceOf(address(this));
        uint256 target = owed - (balance < owed ? balance : owed);
        _sell(AaveExitMarket(ctxMarket), ctxUser, ctxAmount, ctxPayIdx, ctxMaxDiscount, ctxBidIds, target);
        balance = IERC20(asset).balanceOf(address(this));
        if (balance < owed) revert ProceedsTooLow(balance, owed);
        uint256 minProceeds = ctxMinProceeds;
        if (balance < minProceeds) revert ProceedsTooLow(balance, minProceeds);
        IERC20(asset).forceApprove(address(pool), owed);
        return true;
    }

    /// @notice Sells up to `collateralAmount` of the caller's frozen collateral into bids paying in
    /// `market.payTokens()[payIdx]` and supplies all proceeds (net of the market's fee) to Aave for the caller.
    /// @dev Aave checks the caller's health factor when the collateral leaves; the new collateral lands after.
    function swapFrozenCollateral(
        AaveExitMarket market,
        uint256 collateralAmount,
        uint256[] calldata bidIds,
        uint16 maxDiscountBps,
        uint8 payIdx,
        uint256 minProceeds
    ) external nonReentrant returns (uint256 sold, uint256 supplied) {
        if (!isMarket[address(market)]) revert UnknownMarket();
        if (collateralAmount == 0) revert ZeroAmount();
        address newCollateral = market.payTokens()[payIdx];
        IERC20 collateral = market.receipt();
        uint256 before = collateral.balanceOf(address(this));
        _sell(market, msg.sender, collateralAmount, payIdx, maxDiscountBps, bidIds, type(uint256).max);
        supplied = IERC20(newCollateral).balanceOf(address(this));
        if (supplied < minProceeds) revert ProceedsTooLow(supplied, minProceeds);
        IERC20(newCollateral).forceApprove(address(pool), supplied);
        pool.supply(newCollateral, supplied, msg.sender, 0);
        sold = _returnUnsold(collateral, before, collateralAmount);
        emit CollateralSwapped(msg.sender, address(market), sold, newCollateral, supplied);
    }

    /// @dev Pulls the user's collateral and sells it with one `sellNow`. `target` is the net proceeds repay mode needs;
    /// `type(uint256).max` (swap mode) sells everything offered.
    function _sell(
        AaveExitMarket market,
        address user,
        uint256 collateralAmount,
        uint8 payIdx,
        uint16 maxDiscountBps,
        uint256[] memory bidIds,
        uint256 target
    ) internal {
        IERC20 collateral = market.receipt();
        collateral.safeTransferFrom(user, address(this), collateralAmount);
        // Each split transfer of an aToken can round up by one scaled unit; keep that margin unsold.
        uint256 margin = bidIds.length * (pool.getReserveNormalizedIncome(market.underlying()) / RAY + 1);
        if (collateralAmount <= margin) revert ZeroAmount();
        uint256 offer = collateralAmount - margin;
        if (target != type(uint256).max) {
            uint256 sized = _sizeFor(market, bidIds, maxDiscountBps, payIdx, target);
            if (sized < offer) offer = sized;
        }
        collateral.forceApprove(address(market), collateralAmount);
        if (offer > 0) market.sellNow(offer, bidIds, maxDiscountBps, uint8(1 << payIdx), 0);
        collateral.forceApprove(address(market), 0);
    }

    /// @dev Receipt value whose proceeds, net of the market's fee, cover `target`, walking `bidIds` with the skip
    /// rules of `sellNow`.
    function _sizeFor(
        AaveExitMarket market,
        uint256[] memory bidIds,
        uint16 maxDiscountBps,
        uint8 payIdx,
        uint256 target
    ) internal view returns (uint256 assets) {
        uint256 left = target;
        address payToken = market.payTokens()[payIdx];
        uint256 keep = BPS - market.FEE_BPS(); // share of a payment the seller keeps
        for (uint256 k; k < bidIds.length && left > 0; ++k) {
            (address bidder, uint16 minD, uint8 bPayIdx,, uint256 escrow) = market.bids(bidIds[k]);
            if (bidder == address(0) || minD > maxDiscountBps || bPayIdx != payIdx) continue;
            uint256 cap = market.bidCapacity(bidIds[k], minD);
            if (cap == 0) continue;
            uint256 gross = (left * BPS + keep - 1) / keep; // its net covers left
            uint256 f = market.assetsFor(gross, minD, payToken) + 1; // quote(f) > gross
            if (f > cap) f = cap;
            uint256 pay = market.quote(f, minD, payToken);
            if (pay > escrow) pay = escrow;
            uint256 net = pay - market.feeOf(pay);
            assets += f;
            left = net >= left ? 0 : left - net;
        }
    }

    /// @dev Returns the unsold collateral to the caller; `sold` is what left the offered amount.
    function _returnUnsold(IERC20 collateral, uint256 before, uint256 collateralAmount) internal returns (uint256 sold) {
        uint256 unsold = collateral.balanceOf(address(this)) - before;
        sold = unsold >= collateralAmount ? 0 : collateralAmount - unsold;
        if (unsold > 0) collateral.safeTransfer(msg.sender, unsold);
    }
}
