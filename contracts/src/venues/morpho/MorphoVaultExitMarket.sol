// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMorpho, MarketParams, Id, Authorization, Signature, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "morpho-blue/interfaces/IMorphoCallbacks.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";
import {ExitMarket} from "../../market/ExitMarket.sol";
import {PriceRouter} from "../../shared/oracle/PriceRouter.sol";

/// @notice Exit market for the shares of one Morpho Vault V2 (for example a USDC Earn vault).
/// @dev Buyers are borrowers of the vault asset in a Morpho Blue market the vault supplies through `adapter`.
/// Repay-on-behalf flow inside a free Morpho flash loan: repay the buyer's debt, move the freed liquidity from that
/// market to the vault (through the liquidity adapter when it points at that market, otherwise or when requested
/// with `forceDeallocate`), redeem escrowed shares for the same amount, return the flash.
/// `venueData` = `abi.encode(MarketParams market, bool forceDeallocate, bytes auth)`, where `auth` is empty or
/// `abi.encode(Authorization grant, Signature grantSig, Authorization revoke, Signature revokeSig)`.
contract MorphoVaultExitMarket is ExitMarket, IMorphoFlashLoanCallback {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;
    uint256 public constant MAX_LOOPS = 64;

    /// @notice Morpho Blue singleton (debt market and flash source).
    IMorpho public immutable morpho;
    /// @notice Morpho Vault V2 whose shares are the receipt.
    IVaultV2 public immutable vault;
    /// @notice The vault's `MorphoMarketV1AdapterV2` whose markets buyers borrow from.
    address public immutable adapter;

    MarketParams private ctxMarket;

    address private transient ctxBorrower;
    uint256 private transient ctxRepay;
    bool private transient ctxForce;
    bool private transient ctxActive;

    error NoFlashLiquidity();
    error FlashLiquidityTooLow(uint256 chunk, uint256 assets);
    error UnexpectedCallback();
    error WrongMarket();
    error BadAuthorization();
    error AuthorizationNotRevoked();

    constructor(
        IMorpho morpho_,
        IVaultV2 vault_,
        address adapter_,
        PriceRouter prices_,
        address[] memory payTokens_,
        uint256[] memory minEscrows_,
        address feeRecipient_
    ) ExitMarket(IERC20(address(vault_)), vault_.asset(), prices_, payTokens_, minEscrows_, feeRecipient_) {
        if (!vault_.isAdapter(adapter_) || IMorphoMarketV1AdapterV2(adapter_).morpho() != address(morpho_)) {
            revert BadParams();
        }
        morpho = morpho_;
        vault = vault_;
        adapter = adapter_;
        IERC20(vault_.asset()).forceApprove(address(morpho_), type(uint256).max);
    }

    /* -------------------------------------------------------------------------- */
    /*                             Receipt accounting                             */
    /* -------------------------------------------------------------------------- */

    function receiptValue(uint256 amount) public view override returns (uint256) {
        return vault.previewRedeem(amount);
    }

    function _unitsOf(address account) internal view override returns (uint256) {
        return vault.balanceOf(account);
    }

    function _unitsToAssets(uint256 units) internal view override returns (uint256) {
        return vault.previewRedeem(units);
    }

    function _assetsToUnits(uint256 assets, bool roundUp) internal view override returns (uint256) {
        return roundUp ? vault.previewWithdraw(assets) : vault.previewDeposit(assets);
    }

    function _pushUnits(address to, uint256 units) internal override {
        receipt.safeTransfer(to, units);
    }

    function _transferReceiptFrom(address from, address to, uint256 assets) internal override {
        receipt.safeTransferFrom(from, to, vault.previewWithdraw(assets));
    }

    /// @dev Pays what the vault can pay normally (idle cash and its liquidity adapter), then covers any shortfall by
    /// forced deallocation from the adapter's markets with free liquidity, largest first. The forced-deallocation
    /// penalty is taken from the holder's shares, so the result is then below `assets`.
    function _redeemFrom(address holder, uint256 assets, address to) internal override returns (uint256 redeemed) {
        uint256 before = vault.balanceOf(address(this));
        receipt.safeTransferFrom(holder, address(this), vault.previewWithdraw(assets));
        uint256 normal = IERC20(underlying).balanceOf(address(vault)) + _liquidityReach();
        if (normal > assets) normal = assets;
        if (normal > 0) vault.withdraw(normal, to, address(this));
        if (normal == assets) return assets;
        _forceDeallocate(assets - normal);
        uint256 balance = vault.balanceOf(address(this));
        uint256 rest = balance > before ? balance - before : 0;
        redeemed = normal;
        if (rest > 0) redeemed += vault.redeem(rest, to, address(this));
    }

    /// @dev What the vault's liquidity adapter can pay out now, when it is this market's adapter.
    function _liquidityReach() internal view returns (uint256 reach) {
        if (vault.liquidityAdapter() != adapter) return 0;
        MarketParams memory lmp = abi.decode(vault.liquidityData(), (MarketParams));
        (uint256 supplied,, uint256 borrowed,) = morpho.expectedMarketBalances(lmp);
        reach = IMorphoMarketV1AdapterV2(adapter).expectedSupplyAssets(Id.unwrap(lmp.id()));
        uint256 free = supplied - borrowed;
        if (free < reach) reach = free;
    }

    /// @dev Force-deallocates `left` from the adapter's markets, largest free liquidity first (ties: lower index),
    /// each at most the smaller of the adapter's position and the market's free liquidity.
    function _forceDeallocate(uint256 left) internal {
        IMorphoMarketV1AdapterV2 a = IMorphoMarketV1AdapterV2(adapter);
        uint256 n = a.marketIdsLength();
        MarketParams[] memory mps = new MarketParams[](n);
        uint256[] memory free = new uint256[](n);
        uint256[] memory room = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            bytes32 id = a.marketIds(i);
            mps[i] = morpho.idToMarketParams(Id.wrap(id));
            (uint256 supplied,, uint256 borrowed,) = morpho.expectedMarketBalances(mps[i]);
            free[i] = supplied - borrowed;
            uint256 position = a.expectedSupplyAssets(id);
            room[i] = position < free[i] ? position : free[i];
        }
        while (left > 0) {
            uint256 best = n;
            for (uint256 i; i < n; ++i) {
                if (room[i] > 0 && (best == n || free[i] > free[best])) best = i;
            }
            if (best == n) break;
            uint256 amount = left < room[best] ? left : room[best];
            room[best] = 0;
            vault.forceDeallocate(adapter, abi.encode(mps[best]), amount, address(this));
            left -= amount;
        }
    }

    /// @dev Withdrawable now = idle vault assets plus what each adapter market can pay out.
    function _poolStats() internal view override returns (uint256 withdrawable, uint256 supplied, uint256 borrowed) {
        withdrawable = IERC20(underlying).balanceOf(address(vault));
        supplied = vault.totalAssets();
        IMorphoMarketV1AdapterV2 a = IMorphoMarketV1AdapterV2(adapter);
        uint256 n = a.marketIdsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = a.marketIds(i);
            MarketParams memory mp = morpho.idToMarketParams(Id.wrap(id));
            (uint256 totalSupply,, uint256 totalBorrow,) = morpho.expectedMarketBalances(mp);
            uint256 position = a.expectedSupplyAssets(id);
            uint256 free = totalSupply - totalBorrow;
            withdrawable += position < free ? position : free;
            borrowed += totalBorrow;
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                              Debt and health                               */
    /* -------------------------------------------------------------------------- */

    /// @dev The buyer's market must be one the vault supplies, so the repayment frees liquidity the vault can reach.
    function _market(bytes calldata venueData) internal view returns (MarketParams memory mp) {
        (mp,,) = abi.decode(venueData, (MarketParams, bool, bytes));
        if (mp.loanToken != underlying || IMorphoMarketV1AdapterV2(adapter).allocation(mp) == 0) revert WrongMarket();
    }

    function _debtOf(address borrower, bytes calldata venueData) internal view override returns (uint256) {
        return morpho.expectedBorrowAssets(_market(venueData), borrower);
    }

    function _healthOf(address borrower, bytes calldata venueData) internal view override returns (uint256) {
        MarketParams memory mp = _market(venueData);
        uint256 debt = morpho.expectedBorrowAssets(mp, borrower);
        if (debt == 0) return type(uint256).max;
        Position memory p = morpho.position(mp.id(), borrower);
        uint256 maxBorrow =
            Math.mulDiv(Math.mulDiv(p.collateral, IOracle(mp.oracle).price(), ORACLE_PRICE_SCALE), mp.lltv, WAD);
        return Math.mulDiv(maxBorrow, WAD, debt);
    }

    /* -------------------------------------------------------------------------- */
    /*                              Repay on behalf                               */
    /* -------------------------------------------------------------------------- */

    function _repayFor(address borrower, uint256 assets, bytes calldata venueData)
        internal
        override
        returns (uint256 debtRepaid)
    {
        MarketParams memory mp = _market(venueData);
        (, bool force,) = abi.decode(venueData, (MarketParams, bool, bytes));
        // A buy skips forced deallocation only when the vault's withdrawals are served by the buyer's market.
        bool viaLiquidityMarket =
            vault.liquidityAdapter() == adapter && keccak256(vault.liquidityData()) == keccak256(abi.encode(mp));
        force = force || !viaLiquidityMarket;
        uint256 penalty = force ? vault.forceDeallocatePenalty(adapter) : 0;
        // forceDeallocate takes a penalty in shares; size the repayment so the total value used equals `assets`.
        debtRepaid = Math.mulDiv(assets, WAD, WAD + penalty);
        uint256 chunk = IERC20(underlying).balanceOf(address(morpho));
        if (chunk > debtRepaid) chunk = debtRepaid;
        if (chunk == 0) revert NoFlashLiquidity();
        if (Math.ceilDiv(debtRepaid, chunk) > MAX_LOOPS) revert FlashLiquidityTooLow(chunk, debtRepaid);
        ctxBorrower = borrower;
        ctxRepay = debtRepaid;
        ctxForce = force;
        ctxActive = true;
        ctxMarket = mp;
        morpho.flashLoan(underlying, chunk, "");
        ctxActive = false;
        delete ctxMarket;
    }

    /// @notice Morpho flash callback: repay, move the freed liquidity to the vault, burn escrowed shares, per round.
    function onMorphoFlashLoan(uint256 chunk, bytes calldata) external {
        if (msg.sender != address(morpho) || !ctxActive) revert UnexpectedCallback();
        MarketParams memory mp = ctxMarket;
        address borrower = ctxBorrower;
        bool force = ctxForce;
        bytes memory data = abi.encode(mp);
        uint256 left = ctxRepay;
        while (left > 0) {
            uint256 r = left < chunk ? left : chunk;
            morpho.repay(mp, r, 0, borrower, "");
            if (force) vault.forceDeallocate(adapter, data, r, address(this));
            vault.withdraw(r, address(this), address(this));
            left -= r;
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                             Pay with collateral                            */
    /* -------------------------------------------------------------------------- */

    /// @dev Uses the buyer's signed grant, withdraws freed collateral to `to` (the market, which then pays the seller
    /// and the fee recipient), then applies the signed revoke so no authorization survives the transaction. A grant
    /// that someone else submitted first is skipped; the call reverts only if the market is still authorized.
    function _payWithCollateral(address buyer, address payToken, uint256 amount, address to, bytes calldata venueData)
        internal
        override
    {
        (MarketParams memory mp,, bytes memory auth) = abi.decode(venueData, (MarketParams, bool, bytes));
        if (mp.collateralToken != payToken) revert WrongMarket();
        if (auth.length == 0) revert BadAuthorization();
        (Authorization memory grant, Signature memory grantSig, Authorization memory revoke, Signature memory revokeSig)
        = abi.decode(auth, (Authorization, Signature, Authorization, Signature));
        if (
            grant.authorizer != buyer || grant.authorized != address(this) || !grant.isAuthorized
                || revoke.authorizer != buyer || revoke.authorized != address(this) || revoke.isAuthorized
        ) revert BadAuthorization();
        if (!morpho.isAuthorized(buyer, address(this))) morpho.setAuthorizationWithSig(grant, grantSig);
        morpho.withdrawCollateral(mp, amount, buyer, to);
        if (morpho.isAuthorized(buyer, address(this))) morpho.setAuthorizationWithSig(revoke, revokeSig);
        if (morpho.isAuthorized(buyer, address(this))) revert AuthorizationNotRevoked();
    }
}
