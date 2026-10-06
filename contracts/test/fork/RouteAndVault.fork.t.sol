// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {AaveForkBase} from "./AaveForkBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {AaveExitMarket} from "../../src/venues/aave/AaveExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {AaveCollateralRoute} from "../../src/route/AaveCollateralRoute.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {AaveSourceProbe} from "../../src/vault/probes/AaveSourceProbe.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";

/// @dev Aave on Monad does not let WETH be borrowed, so the repay-mode scenes borrow AUSD and sell into AUSD bids;
/// the swap scenes sell into WETH bids and supply the WETH as new collateral.
contract RouteAndVaultForkTest is AaveForkBase {
    address internal constant HYPERITHM_USDC_APEX = 0x78999cc96d2Ba0341588C60CcB0E91c6C33CF371;
    address internal constant HYPERITHM_ADAPTER = 0x068F22739A5f8a5c84619D7F355b678d00707908;
    /// @dev The borrower's debt (B) and the repay target (R) in AUSD; R <= B so the repayment uses the whole flash.
    uint256 internal constant B = 20e6;
    uint256 internal constant R = 10e6;
    /// @dev Vault redemption slack after recovery (base units).
    uint256 internal constant S2 = 20;

    AaveCollateralRoute internal route;
    SelioVault internal ev;
    address internal borrower = makeAddr("borrower");
    address internal depositor = makeAddr("depositor");

    function setUp() public override {
        super.setUp();
        AaveExitMarket[] memory markets = new AaveExitMarket[](1);
        markets[0] = market;
        route = new AaveCollateralRoute(POOL, markets);
        ev = _vault(market, IERC4626(address(0)), ISourceProbe(address(0)));
    }

    function _vault(ExitMarket m, IERC4626 source, ISourceProbe probe) internal returns (SelioVault) {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = m;
        uint16[] memory minD = new uint16[](1);
        minD[0] = 300;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        return new SelioVault(
            "Selio Vault USDC", "slUSDC", IERC20(USDC), markets, minD, maxShare, source, probe, _noKuru(), 5_000
        );
    }

    function _noKuru() internal pure returns (SelioVault.KuruLeg[] memory) {
        return new SelioVault.KuruLeg[](1);
    }

    /// @dev Borrower posted 50 USDC and borrowed B AUSD, seller holds 100 aMonUSDC, then the USDC pool froze to 0.
    function _borrowerScene() internal {
        _supplyUsdc(borrower, 50e6);
        _borrow(borrower, AUSD, B);
        _supplyUsdc(seller, 100e6);
        _freeze(0);
    }

    function _bid(address token, uint8 payIdx, uint256 escrow, uint16 minD) internal returns (uint256 bidId) {
        if (token == AUSD) _dealAusd(bidder, escrow);
        else deal(token, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(token).approve(address(market), escrow);
        bidId = market.placeBid(minD, payIdx, type(uint128).max, escrow);
        vm.stopPrank();
    }

    /// @dev An AUSD bid at 5% whose escrow buys 13 aMonUSDC, more than the 12 the repay tests offer.
    function _ausdBid() internal returns (uint256) {
        return _bid(AUSD, PAY_AUSD, market.quote(13e6, 500, AUSD), 500);
    }

    /// @dev A WETH bid at 5% whose escrow buys 11 aMonUSDC, more than the 10 the swap tests offer.
    function _wethBid() internal returns (uint256) {
        return _bid(WETH, PAY_WETH, market.quote(11e6, 500, WETH), 500);
    }

    function _premium() internal view returns (uint256) {
        // Aave rounds the flash premium half up.
        return (R * POOL.FLASHLOAN_PREMIUM_TOTAL() + 5_000) / 10_000;
    }

    function _approveRoute(uint256 amount) internal {
        vm.prank(borrower);
        IERC20(A_USDC).approve(address(route), amount);
    }

    function test_fork_route_repayWithFrozenCollateral() public {
        _borrowerScene();
        uint256 bidId = _ausdBid();
        uint256 hfBefore = _hf(borrower);
        uint256 collateralBefore = IERC20(A_USDC).balanceOf(borrower);
        _approveRoute(12e6);
        vm.prank(borrower);
        uint256 sold = route.repayWithFrozenCollateral(market, 12e6, _ids(bidId), 500, PAY_AUSD, R, 0);
        assertGt(sold, 0);
        assertLt(sold, 12e6, "sells only what the repayment needs");
        assertApproxEqAbs(collateralBefore - IERC20(A_USDC).balanceOf(borrower), sold, 10, "unsold collateral returned");
        assertGe(IERC20(AUSD).balanceOf(borrower), B, "any surplus proceeds returned");
        assertGt(_hf(borrower), hfBefore, "health improves");
        assertEq(_usdcLiquidity(), 0, "frozen pool untouched");
        assertEq(IERC20(A_USDC).balanceOf(address(route)), 0, "route keeps nothing");
        assertEq(IERC20(AUSD).balanceOf(address(route)), 0, "route keeps nothing");
    }

    function test_fork_route_repay_revertsWhenProceedsTooLow() public {
        _borrowerScene();
        uint256 bidId = _ausdBid();
        _approveRoute(1e6);
        vm.prank(borrower);
        vm.expectRevert();
        route.repayWithFrozenCollateral(market, 1e6, _ids(bidId), 500, PAY_AUSD, R, 0);
    }

    function test_fork_route_swapFrozenCollateral_toWeth() public {
        _borrowerScene();
        uint256 bidId = _wethBid();
        uint256 aWethBefore = IERC20(A_WETH).balanceOf(borrower);
        _approveRoute(10e6);
        vm.prank(borrower);
        (uint256 sold, uint256 supplied) = route.swapFrozenCollateral(market, 10e6, _ids(bidId), 500, PAY_WETH, 1);
        assertGt(sold, 9.99e6);
        assertApproxEqAbs(IERC20(A_WETH).balanceOf(borrower) - aWethBefore, supplied, 2, "new collateral");
        assertGe(_hf(borrower), 1e18);
    }

    function test_fork_route_onlyActsForCaller() public {
        _borrowerScene();
        uint256 bidId = _wethBid();
        _approveRoute(10e6);
        // Someone else cannot spend the borrower's approval: the route pulls from msg.sender only.
        vm.prank(bidder);
        vm.expectRevert();
        route.swapFrozenCollateral(market, 10e6, _ids(bidId), 500, PAY_WETH, 1);
    }

    function test_fork_vault_buysFrozenAUsdc_thenRecovers() public {
        _scene(0);
        deal(USDC, depositor, 100e6);
        vm.startPrank(depositor);
        IERC20(USDC).approve(address(ev), 100e6);
        uint256 shares = ev.deposit(100e6, depositor, 0);
        vm.stopPrank();
        uint256 bidId = ev.bidOf(0);
        vm.startPrank(seller);
        IERC20(A_USDC).approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(30e6, _ids(bidId), 300, 0x02, 1);
        vm.stopPrank();
        assertEq(filled, 20e6, "capped at 20% of vault capital");
        assertEq(IERC20(USDC).balanceOf(seller), 19.4e6 - market.feeOf(19.4e6), "seller paid in USDC at 3%, minus the fee");
        vm.expectRevert();
        ev.recover(0, type(uint256).max);
        _unfreeze(100e6);
        ev.recover(0, type(uint256).max);
        assertLe(ev.heldAssets(0), 10);
        assertGe(ev.totalAssets(), 100.6e6 - 10, "discount captured");
        vm.prank(depositor);
        (uint256 out,,) = ev.redeem(shares, depositor, depositor, new uint256[](0));
        assertGe(out, 100.6e6 - S2);
    }

    /* ------------------------------ Security (Part 0 S8, S9) ------------------------------ */

    function test_fork_route_repay_sellsOnlyWhatRepaymentNeeds() public {
        _borrowerScene();
        uint256 bidId = _ausdBid();
        uint256 premium = _premium();
        // The smallest payment, plus one base unit, whose net after the 0.2% fee covers the flash.
        uint256 gross = ((R + premium) * 10_000 + 9_979) / 9_980;
        uint256 need = market.assetsFor(gross, 500, AUSD) + 1;
        uint256 hfBefore = _hf(borrower);
        uint256 collateralBefore = IERC20(A_USDC).balanceOf(borrower);
        _approveRoute(12e6);
        vm.prank(borrower);
        uint256 sold = route.repayWithFrozenCollateral(market, 12e6, _ids(bidId), 500, PAY_AUSD, R, R + premium);
        assertApproxEqAbs(sold, need, 2, "sells only what the repayment needs");
        assertApproxEqAbs(collateralBefore - IERC20(A_USDC).balanceOf(borrower), sold, 10);
        assertLe(IERC20(AUSD).balanceOf(borrower), B + market.quote(1, 500, AUSD) + 2);
        assertGt(_hf(borrower), hfBefore);
        assertEq(IERC20(A_USDC).balanceOf(address(route)), 0);
        assertEq(IERC20(AUSD).balanceOf(address(route)), 0);
    }

    function test_fork_route_rejectsUnknownMarket() public {
        AaveExitMarket other = _deployMarket(IMorpho(address(0)));
        assertTrue(route.isMarket(address(market)));
        assertFalse(route.isMarket(address(other)));
        vm.startPrank(borrower);
        vm.expectRevert(AaveCollateralRoute.UnknownMarket.selector);
        route.repayWithFrozenCollateral(other, 1e6, new uint256[](0), 500, PAY_AUSD, 1, 0);
        vm.expectRevert(AaveCollateralRoute.UnknownMarket.selector);
        route.swapFrozenCollateral(other, 1e6, new uint256[](0), 500, PAY_WETH, 0);
        vm.stopPrank();
    }

    /* ------------------------------ Protocol fee (Part 0 §0.12) ------------------------------ */

    function test_fork_route_fee_netProceedsCoverFlash() public {
        _borrowerScene();
        uint256 escrow = market.quote(13e6, 500, AUSD);
        uint256 bidId = _bid(AUSD, PAY_AUSD, escrow, 500);
        uint256 premium = _premium();
        _approveRoute(12e6);
        vm.prank(borrower);
        route.repayWithFrozenCollateral(market, 12e6, _ids(bidId), 500, PAY_AUSD, R, R + premium);
        (address live,,,, uint256 left) = market.bids(bidId);
        assertEq(live, bidder, "the bid is still live");
        uint256 pay = escrow - left;
        uint256 fee = market.feeOf(pay);
        uint256 surplus = IERC20(AUSD).balanceOf(borrower) - B;
        assertGt(fee, 0);
        assertEq(IERC20(AUSD).balanceOf(treasury), fee, "the bid paid the full price and the fee came out of the route's side");
        assertEq(pay - fee, R + premium + surplus, "the route received the net proceeds");
        assertGe(pay - fee, R + premium, "net proceeds cover the flash debt");
        assertEq(IERC20(AUSD).balanceOf(address(route)), 0);
        assertEq(IERC20(A_USDC).balanceOf(address(route)), 0);
    }

    /* ------------------------------ Base yield (Part 0 §0.13) ------------------------------ */

    function test_fork_aaveSourceProbe_readsUsdcReserve() public {
        AaveSourceProbe probe = new AaveSourceProbe(POOL, USDC, A_USDC);
        (uint256 withdrawable, uint256 supplied) = probe.liquidity();
        assertEq(withdrawable, POOL.getVirtualUnderlyingBalance(USDC));
        assertEq(supplied, IERC20(A_USDC).totalSupply());
        assertEq(probe.receipt(), A_USDC);
        assertEq(IERC4626(STATIC_A_USDC).asset(), USDC, "waMonUSDC holds USDC");
    }

    function test_fork_vault_rejectsSourceOnItsProtectedPool() public {
        // waMonUSDC supplies the aMonUSDC pool that this vault's market protects.
        AaveSourceProbe probe = new AaveSourceProbe(POOL, USDC, A_USDC);
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        vm.expectRevert(SelioVault.BadParams.selector);
        new SelioVault("x", "x", IERC20(USDC), markets, minD, maxShare, IERC4626(STATIC_A_USDC), probe, _noKuru(), 5_000);
    }

    function test_fork_vault_staticATokenSource_depositAndRedeem() public {
        // The vault-freeze configuration: a market on Hyperithm USDC Apex, base yield in waMonUSDC.
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (USDC, WETH);
        uint256[] memory minEscrows = new uint256[](2);
        (minEscrows[0], minEscrows[1]) = (1, 1);
        MorphoVaultExitMarket morphoMarket = new MorphoVaultExitMarket(
            IMorpho(MORPHO), IVaultV2(HYPERITHM_USDC_APEX), HYPERITHM_ADAPTER, prices, tokens, minEscrows, treasury
        );
        SelioVault yieldVault =
            _vault(morphoMarket, IERC4626(STATIC_A_USDC), new AaveSourceProbe(POOL, USDC, A_USDC));
        // Bring the USDC reserve below 90% utilization so the vault deposits into the source.
        uint256 supplied = IERC20(A_USDC).totalSupply();
        uint256 withdrawable = _usdcLiquidity();
        if (withdrawable * 10 < supplied + supplied / 50) _supplyUsdc(whale, (supplied / 5 - withdrawable * 2));
        assertLt(yieldVault.sourceUtilizationBps(), 9_000);

        deal(USDC, depositor, 1_000e6);
        vm.startPrank(depositor);
        IERC20(USDC).approve(address(yieldVault), 1_000e6);
        uint256 shares = yieldVault.deposit(1_000e6, depositor, 0);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(address(yieldVault)), 0, "the cash beyond escrow went to waMonUSDC");
        assertEq(yieldVault.sourceShares(), IERC20(STATIC_A_USDC).balanceOf(address(yieldVault)));
        assertApproxEqAbs(yieldVault.sourceAssets(), 800e6, 2);
        assertApproxEqAbs(yieldVault.totalAssets(), 1_000e6, 2);

        vm.prank(depositor);
        (uint256 assets,, uint256 inKind) = yieldVault.redeem(shares, depositor, depositor, new uint256[](0));
        assertEq(inKind, 0, "a liquid source pays in cash");
        assertApproxEqAbs(assets, 1_000e6, 3);
        assertEq(IERC20(USDC).balanceOf(depositor), assets);
    }
}
