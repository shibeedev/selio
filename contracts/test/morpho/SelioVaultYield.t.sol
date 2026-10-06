// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoBase} from "./MorphoBase.t.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {MorphoVaultSourceProbe} from "../../src/vault/probes/MorphoVaultSourceProbe.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";

/// @notice Base yield of the Selio Vault (Part 0 §0.13): a second Vault V2 on its own Morpho market is the source.
contract SelioVaultYieldTest is MorphoBase {
    using MorphoBalancesLib for IMorpho;

    IVaultV2 internal yv;
    MarketParams internal ym;
    MorphoVaultSourceProbe internal probe;
    SelioVault internal ev;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal yieldBorrower = makeAddr("yieldBorrower");

    function setUp() public override {
        super.setUp();
        (yv,, ym) = _buildYieldVault(s, address(this), "Yield USDC", "yUSDC");
        probe = new MorphoVaultSourceProbe(yv);
        ev = _newVault(IERC4626(address(yv)), ISourceProbe(address(probe)));
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(ev), amount);
        shares = ev.deposit(amount, who, 0);
        vm.stopPrank();
    }

    function _redeemAll(address who) internal returns (uint256 assets, uint256 sourceInKind) {
        uint256 shares = ev.balanceOf(who);
        vm.prank(who);
        (assets,, sourceInKind) = ev.redeem(shares, who, who, new uint256[](0));
    }

    /// @dev Borrows `amount` from the yield market against twice its value in AUSD-sim.
    function _borrowFromSource(uint256 amount) internal {
        uint256 collateral = amount * 2 * 1e12;
        ausd.mint(yieldBorrower, collateral);
        vm.startPrank(yieldBorrower);
        ausd.approve(address(morpho), collateral);
        morpho.supplyCollateral(ym, collateral, yieldBorrower, "");
        morpho.borrow(ym, amount, 0, yieldBorrower, yieldBorrower);
        vm.stopPrank();
    }

    function _escrow() internal view returns (uint256 escrow) {
        (,,,, escrow) = market.bids(ev.bidOf(0));
    }

    function test_yield_depositMovesExcessToSource() public {
        usdc.mint(alice, 100_000 * USD);
        vm.prank(alice);
        usdc.approve(address(ev), 100_000 * USD);
        uint256 minted = yv.previewDeposit(80_000 * USD);
        vm.expectEmit(address(ev));
        emit SelioVault.SourceDeposited(80_000 * USD, minted);
        vm.prank(alice);
        ev.deposit(100_000 * USD, alice, 0);
        assertEq(_escrow(), 20_000 * USD, "bid escrow is 20% of capital");
        assertEq(usdc.balanceOf(address(ev)), 0, "the cash beyond escrow went to the source");
        assertEq(ev.sourceShares(), yv.balanceOf(address(ev)));
        assertApproxEqAbs(ev.sourceAssets(), 80_000 * USD, 1);
        assertApproxEqAbs(ev.totalAssets(), 100_000 * USD, 1);
        assertEq(ev.idleAssets(), 20_000 * USD);
        assertEq(ev.sourceUtilizationBps(), 0);
    }

    function test_yield_escrowNeverInSource() public {
        _deposit(alice, 100_000 * USD);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        market.sellNow(10_000 * USD, _ids(ev.bidOf(0)), 500, 0x01, 1);
        vm.stopPrank();
        ev.refreshBids();
        uint256 escrow = _escrow();
        assertEq(market.totalEscrow(address(usdc)), escrow, "the bid escrow sits in the market");
        assertEq(usdc.balanceOf(address(market)), escrow, "the bid escrow sits in the market");
        assertApproxEqAbs(
            yv.totalAssets(), ev.totalAssets() - escrow - ev.heldCost(0), 2, "the source holds only cash beyond escrow"
        );
    }

    function test_yield_pullFromSource_revertsBelowThreshold_worksAtOrAbove() public {
        _deposit(alice, 100_000 * USD);
        vm.expectRevert(SelioVault.SourceNotTight.selector);
        ev.pullFromSource();

        _borrowFromSource(71_992 * USD); // 89.99%
        assertEq(ev.sourceUtilizationBps(), 8_999);
        vm.expectRevert(SelioVault.SourceNotTight.selector);
        ev.pullFromSource();

        _borrowFromSource(8 * USD); // exactly 90%
        assertEq(ev.sourceUtilizationBps(), 9_000);
        uint256 sharesBefore = ev.sourceShares();
        uint256 totalBefore = ev.totalAssets();
        vm.prank(keeper);
        (uint256 assets, uint256 shares) = ev.pullFromSource();
        assertApproxEqAbs(assets, 8_000 * USD, 1, "pulls what the source can pay now");
        assertEq(usdc.balanceOf(address(ev)), assets, "the assets stay in the vault");
        assertEq(ev.sourceShares(), sharesBefore - shares);
        assertApproxEqAbs(ev.totalAssets(), totalBefore, 1);
        assertEq(ev.sourceUtilizationBps(), 10_000);

        // While the source is tight, no operation deposits into it.
        _deposit(bob, 10_000 * USD);
        assertEq(ev.sourceShares(), sharesBefore - shares);
    }

    /// @dev Vault V2 caches its accrued total in transient storage within a transaction; isolate mode runs each
    /// call as its own transaction, as on chain.
    /// forge-config: default.isolate = true
    function test_yield_refreshWithdrawsFromSourceToFundEscrowGrowth() public {
        _deposit(alice, 100_000 * USD);
        _borrowFromSource(72_000 * USD);
        vm.warp(block.timestamp + 365 days);
        uint256 total = ev.totalAssets();
        assertGt(total, 100_000 * USD + 1_000 * USD, "the source earned interest");
        uint256 sharesBefore = ev.sourceShares();
        assertEq(usdc.balanceOf(address(ev)), 0);
        ev.refreshBids();
        assertApproxEqAbs(_escrow(), total * 2_000 / 10_000, 1, "escrow grew to 20% of capital");
        assertLt(ev.sourceShares(), sharesBefore, "the growth came from the source");
        assertEq(usdc.balanceOf(address(ev)), 0, "only the shortfall was withdrawn");
        assertApproxEqAbs(ev.totalAssets(), total, 2);
    }

    function test_yield_redeemPaysSourcePartInKindWhenFrozen() public {
        uint256 shares = _deposit(alice, 100_000 * USD);
        _borrowFromSource(80_000 * USD); // the source can pay nothing now
        assertEq(ev.sourceUtilizationBps(), 10_000);
        (uint256 previewAssets,, uint256 previewInKind) = ev.previewRedeem(shares);
        uint256 sourceShares = ev.sourceShares();
        uint256 expectedInKind = sourceShares * shares / (shares + 1000);
        assertEq(previewInKind, expectedInKind);
        vm.expectEmit(address(ev));
        emit SelioVault.SourceSharesInKind(alice, expectedInKind);
        vm.prank(alice);
        (uint256 assets,, uint256 inKind) = ev.redeem(shares, alice, alice, new uint256[](0));
        assertEq(assets, previewAssets);
        assertApproxEqAbs(assets, 20_000 * USD, 1, "idle capital in cash");
        assertEq(inKind, expectedInKind, "the source part in kind");
        assertEq(usdc.balanceOf(alice), assets);
        assertEq(yv.balanceOf(alice), inKind);
        assertEq(ev.sourceShares(), sourceShares - inKind);
    }

    function test_yield_redeemPaysWhatTheSourceCanInCash() public {
        uint256 shares = _deposit(alice, 100_000 * USD);
        _borrowFromSource(76_000 * USD); // the source can pay 4,000 now
        (uint256 previewAssets,, uint256 previewInKind) = ev.previewRedeem(shares);
        (uint256 assets, uint256 inKind) = _redeemAll(alice);
        assertEq(assets, previewAssets);
        assertEq(inKind, previewInKind);
        assertApproxEqAbs(assets, 24_000 * USD, 2, "idle capital and the source's liquid part in cash");
        assertApproxEqAbs(yv.previewRedeem(inKind), 76_000 * USD, 2, "the rest of the source part in kind");
    }

    function test_yield_sourceSharesSentDirectlyAreIgnored() public {
        _deposit(alice, 100_000 * USD);
        uint256 ta = ev.totalAssets();
        uint256 pd = ev.previewDeposit(1_000e6);
        uint256 tracked = ev.sourceShares();
        usdc.mint(bob, 10_000 * USD);
        vm.startPrank(bob);
        usdc.approve(address(yv), 10_000 * USD);
        uint256 donated = yv.deposit(10_000 * USD, bob);
        yv.transfer(address(ev), donated);
        vm.stopPrank();
        assertEq(ev.sourceShares(), tracked, "only shares the vault minted are tracked");
        assertEq(ev.totalAssets(), ta, "a donation does not move the share price");
        assertEq(ev.previewDeposit(1_000e6), pd, "a donation does not move the share price");
        _redeemAll(alice);
        assertGe(yv.balanceOf(address(ev)), donated, "donated source shares are not paid out");
    }

    /// @dev Vault V2 caches its accrued total in transient storage within a transaction; isolate mode runs each
    /// call as its own transaction, as on chain.
    /// forge-config: default.isolate = true
    function test_yield_sharePriceRisesWithSourceInterest() public {
        _deposit(alice, 100_000 * USD);
        _borrowFromSource(72_000 * USD);
        uint256 ta = ev.totalAssets();
        uint256 pd = ev.previewDeposit(1_000e6);
        vm.warp(block.timestamp + 365 days);
        assertGt(ev.totalAssets(), ta, "source interest belongs to depositors");
        assertLt(ev.previewDeposit(1_000e6), pd, "a later deposit gets fewer shares");
        (uint256 assets, uint256 inKind) = _redeemAll(alice);
        assertGt(assets + yv.previewRedeem(inKind), 100_000 * USD, "the depositor exits with the interest");
    }

    function test_yield_noDepositWhileSourceTight() public {
        usdc.mint(bob, 100_000 * USD);
        vm.startPrank(bob);
        usdc.approve(address(yv), 100_000 * USD);
        yv.deposit(100_000 * USD, bob);
        vm.stopPrank();
        _borrowFromSource(95_000 * USD);
        assertEq(ev.sourceUtilizationBps(), 9_500);
        _deposit(alice, 100_000 * USD);
        assertEq(ev.sourceShares(), 0, "nothing deposited at or above 90%");
        assertEq(usdc.balanceOf(address(ev)), 80_000 * USD, "the cash beyond escrow stays idle");
    }

    function test_yield_probeMeasuresLiquidityMarket() public {
        _deposit(alice, 100_000 * USD);
        _borrowFromSource(30_000 * USD);
        (uint256 withdrawable, uint256 supplied) = probe.liquidity();
        assertApproxEqAbs(withdrawable, 50_000 * USD, 1);
        assertApproxEqAbs(supplied, 80_000 * USD, 1);
        assertEq(probe.receipt(), address(yv));
        assertEq(ev.sourceUtilizationBps(), 3_750);
    }

    function test_yield_constructorGuards() public {
        // The source's asset must be the vault asset.
        VaultV2 ausdVault = new VaultV2(address(this), address(ausd));
        MorphoVaultSourceProbe ausdProbe = new MorphoVaultSourceProbe(IVaultV2(address(ausdVault)));
        vm.expectRevert(SelioVault.BadParams.selector);
        _newVault(IERC4626(address(ausdVault)), ausdProbe);
        // The source cannot be a strategy's receipt.
        MorphoVaultSourceProbe earnProbe = new MorphoVaultSourceProbe(vault);
        vm.expectRevert(SelioVault.BadParams.selector);
        _newVault(IERC4626(address(vault)), earnProbe);
        // The probe cannot measure a strategy's protected pool.
        vm.expectRevert(SelioVault.BadParams.selector);
        _newVault(IERC4626(address(yv)), earnProbe);
        // A source needs a probe and a probe needs a source.
        vm.expectRevert(SelioVault.BadParams.selector);
        _newVault(IERC4626(address(yv)), ISourceProbe(address(0)));
        vm.expectRevert(SelioVault.BadParams.selector);
        _newVault(IERC4626(address(0)), probe);
        assertEq(address(ev.yieldSource()), address(yv));
        assertEq(address(ev.sourceProbe()), address(probe));
    }
}
