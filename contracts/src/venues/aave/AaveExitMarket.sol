// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "morpho-blue/interfaces/IMorphoCallbacks.sol";
import {ExitMarket} from "../../market/ExitMarket.sol";
import {PriceRouter} from "../../shared/oracle/PriceRouter.sol";
import {IAavePool, IAToken, IFlashLoanSimpleReceiver} from "../../shared/interfaces/IAaveV3.sol";

/// @notice Exit market for one Aave V3 aToken (for example aMonUSDC).
/// @dev Repay-on-behalf flow: flash-borrow the underlying, repay the buyer's variable debt, withdraw the same amount
/// from escrowed aTokens, return the flash. The loop runs inside one flash so a small flash amount can process a
/// large purchase. Flash source: an external Morpho Blue singleton (free) when it can lend at least as much as the
/// Aave pool itself, otherwise Aave `flashLoanSimple`.
contract AaveExitMarket is ExitMarket, IFlashLoanSimpleReceiver, IMorphoFlashLoanCallback {
    using SafeERC20 for IERC20;

    uint256 internal constant RAY = 1e27;
    uint256 public constant MAX_LOOPS = 64;
    uint256 internal constant VARIABLE_RATE = 2;

    IAavePool public immutable pool;
    IERC20 public immutable debtToken;
    /// @notice Optional free flash source (Morpho Blue singleton); `address(0)` when absent.
    IMorpho public immutable externalFlash;
    /// @notice aToken of each pay token usable in flash mode.
    mapping(address => address) public collateralATokenOf;

    address private transient ctxBorrower;
    uint256 private transient ctxAssets;
    uint256 private transient ctxRepaid;
    bool private transient ctxActive;

    error NoFlashLiquidity();
    error FlashLiquidityTooLow(uint256 chunk, uint256 assets);
    error UnexpectedCallback();
    error NoCollateralToken(address payToken);

    constructor(
        IAavePool pool_,
        address aToken_,
        address debtToken_,
        PriceRouter prices_,
        address[] memory payTokens_,
        address[] memory payATokens_,
        IMorpho externalFlash_,
        uint256[] memory minEscrows_,
        address feeRecipient_
    )
        ExitMarket(
            IERC20(aToken_), IAToken(aToken_).UNDERLYING_ASSET_ADDRESS(), prices_, payTokens_, minEscrows_, feeRecipient_
        )
    {
        if (payATokens_.length != payTokens_.length) revert BadParams();
        pool = pool_;
        debtToken = IERC20(debtToken_);
        externalFlash = externalFlash_;
        for (uint256 i; i < payTokens_.length; ++i) {
            address aToken = payATokens_[i];
            if (aToken == address(0)) continue;
            if (IAToken(aToken).UNDERLYING_ASSET_ADDRESS() != payTokens_[i]) revert BadParams();
            collateralATokenOf[payTokens_[i]] = aToken;
        }
        IERC20 asset = IERC20(IAToken(aToken_).UNDERLYING_ASSET_ADDRESS());
        asset.forceApprove(address(pool_), type(uint256).max);
        if (address(externalFlash_) != address(0)) asset.forceApprove(address(externalFlash_), type(uint256).max);
    }

    /* -------------------------------------------------------------------------- */
    /*                             Receipt accounting                             */
    /* -------------------------------------------------------------------------- */

    /// @notice aToken balances are already in underlying units.
    function receiptValue(uint256 amount) public pure override returns (uint256) {
        return amount;
    }

    function _index() internal view returns (uint256) {
        return pool.getReserveNormalizedIncome(underlying);
    }

    function _unitsOf(address account) internal view override returns (uint256) {
        return IAToken(address(receipt)).scaledBalanceOf(account);
    }

    function _unitsToAssets(uint256 units) internal view override returns (uint256) {
        return Math.mulDiv(units, _index(), RAY);
    }

    function _assetsToUnits(uint256 assets, bool roundUp) internal view override returns (uint256) {
        return Math.mulDiv(assets, RAY, _index(), roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor);
    }

    /// @dev Transfers the rounded-down value of `units`, so at most `units` scaled units leave the market.
    function _pushUnits(address to, uint256 units) internal override {
        uint256 amount = _unitsToAssets(units);
        if (amount > 0) receipt.safeTransfer(to, amount);
    }

    function _transferReceiptFrom(address from, address to, uint256 assets) internal override {
        receipt.safeTransferFrom(from, to, assets);
    }

    /// @dev Aave checks withdrawals against the rounded balance, which can be a few wei below a transfer of the same
    /// amount; withdraw the rounded-down value of the units received so escrow is never touched.
    function _redeemFrom(address holder, uint256 assets, address to) internal override returns (uint256 redeemed) {
        uint256 before = _unitsOf(address(this));
        receipt.safeTransferFrom(holder, address(this), assets);
        redeemed = _unitsToAssets(_unitsOf(address(this)) - before);
        if (redeemed > 0) pool.withdraw(underlying, redeemed, to);
    }

    /// @dev Withdrawable is Aave's virtual balance, which underlying sent to the aToken directly does not raise.
    function _poolStats() internal view override returns (uint256 withdrawable, uint256 supplied, uint256 borrowed) {
        withdrawable = pool.getVirtualUnderlyingBalance(underlying);
        supplied = receipt.totalSupply();
        borrowed = debtToken.totalSupply();
    }

    /* -------------------------------------------------------------------------- */
    /*                              Debt and health                               */
    /* -------------------------------------------------------------------------- */

    function _debtOf(address borrower, bytes calldata) internal view override returns (uint256) {
        return debtToken.balanceOf(borrower);
    }

    function _healthOf(address borrower, bytes calldata) internal view override returns (uint256 healthFactor) {
        (,,,,, healthFactor) = pool.getUserAccountData(borrower);
    }

    /* -------------------------------------------------------------------------- */
    /*                              Repay on behalf                               */
    /* -------------------------------------------------------------------------- */

    /// @notice Largest flash each source can give now. The Aave chunk is sized from Aave's virtual balance.
    function flashCapacity() public view returns (uint256 aaveChunk, uint256 externalChunk) {
        uint256 liquidity = pool.getVirtualUnderlyingBalance(underlying);
        uint256 premiumBps = pool.FLASHLOAN_PREMIUM_TOTAL();
        // The premium is withdrawn from the pool after the flash amount left it, so keep room for it.
        aaveChunk = liquidity * BPS / (BPS + premiumBps);
        aaveChunk = aaveChunk > 1 ? aaveChunk - 1 : 0;
        if (address(externalFlash) != address(0)) externalChunk = IERC20(underlying).balanceOf(address(externalFlash));
    }

    function _repayFor(address borrower, uint256 assets, bytes calldata) internal override returns (uint256) {
        (uint256 aaveChunk, uint256 extChunk) = flashCapacity();
        if (aaveChunk > assets) aaveChunk = assets;
        if (extChunk > assets) extChunk = assets;
        bool useExternal = extChunk > 0 && extChunk >= aaveChunk;
        uint256 chunk = useExternal ? extChunk : aaveChunk;
        if (chunk == 0) revert NoFlashLiquidity();
        if (Math.ceilDiv(assets, chunk) > MAX_LOOPS) revert FlashLiquidityTooLow(chunk, assets);
        ctxBorrower = borrower;
        ctxAssets = assets;
        ctxActive = true;
        if (useExternal) externalFlash.flashLoan(underlying, chunk, "");
        else pool.flashLoanSimple(address(this), underlying, chunk, "", 0);
        ctxActive = false;
        return ctxRepaid;
    }

    /// @notice Morpho flash callback.
    function onMorphoFlashLoan(uint256 chunk, bytes calldata) external {
        if (msg.sender != address(externalFlash) || !ctxActive) revert UnexpectedCallback();
        ctxRepaid = _repayLoop(chunk, ctxAssets, 0);
    }

    /// @notice Aave flash callback.
    function executeOperation(address asset, uint256 chunk, uint256 premium, address initiator, bytes calldata)
        external
        returns (bool)
    {
        if (msg.sender != address(pool) || initiator != address(this) || asset != underlying || !ctxActive) {
            revert UnexpectedCallback();
        }
        uint256 assets = ctxAssets;
        if (premium >= assets) revert NoFlashLiquidity();
        ctxRepaid = _repayLoop(chunk, assets - premium, premium);
        return true;
    }

    /// @dev Repays `toRepay` in rounds of at most `chunk`, withdrawing each round back from escrowed aTokens; the last
    /// withdrawal adds `fee` (the flash premium) so the lender is repaid in full.
    function _repayLoop(uint256 chunk, uint256 toRepay, uint256 fee) internal returns (uint256 repaid) {
        address borrower = ctxBorrower;
        uint256 left = toRepay;
        while (left > 0) {
            uint256 r = left < chunk ? left : chunk;
            uint256 paid = pool.repay(underlying, r, VARIABLE_RATE, borrower);
            if (paid != r) revert DebtTooSmall(repaid + paid, toRepay);
            repaid += r;
            left -= r;
            pool.withdraw(underlying, left == 0 ? r + fee : r, address(this));
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                             Pay with collateral                            */
    /* -------------------------------------------------------------------------- */

    /// @notice Extra aToken wei pulled in flash mode to absorb Aave's rounding; the unused part is refunded at once.
    function collateralPullMargin(address payToken) public view returns (uint256) {
        return pool.getReserveNormalizedIncome(payToken) / RAY + 2;
    }

    /// @dev The buyer approves this market once for their collateral aToken (amount plus `collateralPullMargin`).
    /// Reverts if that pool is illiquid.
    function _payWithCollateral(address buyer, address payToken, uint256 amount, address to, bytes calldata)
        internal
        override
    {
        address aToken = collateralATokenOf[payToken];
        if (aToken == address(0)) revert NoCollateralToken(payToken);
        IERC20(aToken).safeTransferFrom(buyer, address(this), amount + collateralPullMargin(payToken));
        pool.withdraw(payToken, amount, to);
        uint256 dust = IERC20(aToken).balanceOf(address(this));
        if (dust > 0) IERC20(aToken).safeTransfer(buyer, dust);
    }
}
