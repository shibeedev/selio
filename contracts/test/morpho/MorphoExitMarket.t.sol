// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMorpho, MarketParams, Authorization, Signature} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";

contract MorphoExitMarketTest is MorphoBase {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    function _placeBid(address who, uint16 minDiscount, uint256 maxAssets, uint256 escrow) internal returns (uint256) {
        usdc.mint(who, escrow);
        vm.startPrank(who);
        usdc.approve(address(market), escrow);
        uint256 id = market.placeBid(minDiscount, PAY_USDC, maxAssets, escrow);
        vm.stopPrank();
        return id;
    }

    function _buy(uint256 id, uint256 assets, uint8 payIdx, uint256 maxPay, bytes memory venue)
        internal
        returns (uint256 paid, uint256 repaid)
    {
        vm.prank(buyer);
        return market.buyAndRepay(id, assets, payIdx, maxPay, venue);
    }

    function _approveBuyer(uint256 amount) internal {
        vm.prank(buyer);
        usdc.approve(address(market), amount);
    }

    function _earnFreeLiquidity() internal view returns (uint256) {
        (uint256 supplied,, uint256 borrowed,) = morpho.expectedMarketBalances(s.earnMarket);
        return supplied - borrowed;
    }

    function _setPenaltyWithoutLiquidityAdapter() internal {
        _timelocked(vault, abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (s.adapter, 0.01e18)));
        // only forced deallocation can free liquidity
        vault.setLiquidityAdapterAndData(address(0), "");
    }

    /* ------------------------------ Sessions ------------------------------ */

    function test_setup_poolIsFrozen() public view {
        ExitMarket.Capacity memory c = market.capacity();
        assertEq(c.withdrawable, 0);
        assertEq(c.utilizationBps, 10_000);
        assertEq(c.debtorCapacity, 1_000_000 * USD);
        assertApproxEqAbs(c.supplied, 1_000_000 * USD, 1);
    }

    function test_openSession_escrowsShares() public {
        uint256 id = _openSession(100_000 * USD);
        assertTrue(market.isOpen(id));
        assertApproxEqAbs(market.remainingAssets(id), 100_000 * USD, 1);
        assertEq(market.discountOf(id), 100);
        assertEq(vault.balanceOf(address(market)), market.totalSessionUnits());
    }

    function test_discount_risesByStepsUpToCap() public {
        uint256 id = _openSession(10_000 * USD);
        assertEq(market.discountOf(id), 100);
        vm.warp(block.timestamp + 3_599);
        assertEq(market.discountOf(id), 100);
        vm.warp(block.timestamp + 1);
        assertEq(market.discountOf(id), 150);
        vm.warp(block.timestamp + 100 hours);
        assertEq(market.discountOf(id), 1000);
    }

    function test_withdrawUnsold_anytime_returnsShares() public {
        uint256 sharesBefore = vault.balanceOf(seller);
        uint256 id = _openSession(50_000 * USD);
        vm.prank(seller);
        market.withdrawUnsold(id, type(uint256).max);
        assertEq(vault.balanceOf(seller), sharesBefore);
        assertFalse(market.isOpen(id));
        assertEq(market.totalSessionUnits(), 0);
    }

    function test_withdrawUnsold_onlySeller() public {
        uint256 id = _openSession(50_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.NotSeller.selector);
        market.withdrawUnsold(id, 1);
    }

    function test_openSession_rejectsBadParams() public {
        ExitMarket.SessionParams memory p = _defaultParams();
        p.capBps = 6000;
        vm.prank(seller);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e6, p);
        p = _defaultParams();
        p.payMask = 0x04; // only two pay tokens
        vm.prank(seller);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e6, p);
    }

    /* ------------------------------ Buy and repay ------------------------------ */

    function test_buyAndRepay_wallet_repaysDebtAndKeepsLiquidity() public {
        uint256 id = _openSession(100_000 * USD);
        uint256 price = market.quote(50_000 * USD, market.discountOf(id), address(usdc));
        assertEq(price, 49_500 * USD, "1% discount");
        uint256 debtBefore = _debt(buyer);
        uint256 liquidityBefore = _withdrawable();
        uint256 sellerBefore = usdc.balanceOf(seller);
        _approveBuyer(price);
        (uint256 paid, uint256 repaid) = _buy(id, 50_000 * USD, PAY_USDC, price, _venue(false, ""));
        assertEq(paid, price);
        assertEq(repaid, 50_000 * USD, "Morpho flash is free");
        assertApproxEqAbs(debtBefore - _debt(buyer), 50_000 * USD, 1, "debt repaid at face value");
        assertEq(usdc.balanceOf(seller) - sellerBefore, price - market.feeOf(price));
        assertEq(_withdrawable(), liquidityBefore, "withdrawable liquidity unchanged");
        assertApproxEqAbs(market.remainingAssets(id), 50_000 * USD, 2);
        assertEq(vault.balanceOf(address(market)), market.totalSessionUnits(), "units accounted");
    }

    function test_buyAndRepay_payInOtherToken() public {
        uint256 id = _openSession(20_000 * USD);
        vm.warp(block.timestamp + 2 hours); // 2% discount
        uint256 price = market.quote(10_000 * USD, 200, address(ausd));
        assertEq(price, 9_800 ether);
        ausd.mint(buyer, price);
        vm.prank(buyer);
        ausd.approve(address(market), price);
        _buy(id, 10_000 * USD, PAY_AUSD, price, _venue(false, ""));
        assertEq(ausd.balanceOf(seller), price - market.feeOf(price));
    }

    function test_buyAndRepay_smallFlashLiquidity_loops() public {
        _withdrawFlashMarket(190_000 * USD); // 10k USDC left to flash
        uint256 id = _openSession(100_000 * USD);
        uint256 price = market.quote(95_000 * USD, 100, address(usdc));
        uint256 debtBefore = _debt(buyer);
        _approveBuyer(price);
        _buy(id, 95_000 * USD, PAY_USDC, price, _venue(false, ""));
        assertApproxEqAbs(debtBefore - _debt(buyer), 95_000 * USD, 10, "debt repaid over 10 rounds");
        assertEq(_withdrawable(), 0);
    }

    function test_buyAndRepay_revertsWithoutFlashLiquidity() public {
        _withdrawFlashMarket(200_000 * USD);
        uint256 id = _openSession(10_000 * USD);
        _approveBuyer(type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(MorphoVaultExitMarket.NoFlashLiquidity.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_revertsWhenFlashTooSmallForLoopCap() public {
        _withdrawFlashMarket(200_000 * USD - 100 * USD); // 100 USDC left
        uint256 id = _openSession(10_000 * USD);
        _approveBuyer(type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert();
        market.buyAndRepay(id, 10_000 * USD - 10, PAY_USDC, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_priceAboveMax() public {
        uint256 id = _openSession(10_000 * USD);
        _approveBuyer(type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ExitMarket.PriceTooHigh.selector, 990e6, 989e6));
        market.buyAndRepay(id, 1_000 * USD, PAY_USDC, 989e6, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_debtTooSmall() public {
        uint256 id = _openSession(500_000 * USD);
        _approveBuyer(type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert();
        market.buyAndRepay(id, 400_000 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_payTokenNotAccepted() public {
        ExitMarket.SessionParams memory p = _defaultParams();
        p.payMask = 0x01; // USDC only
        uint256 id = _openSession(10_000 * USD, p);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.PayTokenNotAccepted.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_AUSD, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_afterSessionEnds() public {
        uint256 id = _openSession(10_000 * USD);
        vm.warp(block.timestamp + 7 days);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.SessionClosed.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_moreThanSession() public {
        uint256 id = _openSession(10_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.NotEnoughUnits.selector);
        market.buyAndRepay(id, 10_001 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_wholeSession() public {
        uint256 id = _openSession(10_000 * USD);
        _approveBuyer(type(uint256).max);
        _buy(id, market.remainingAssets(id), PAY_USDC, type(uint256).max, _venue(false, ""));
        assertLe(market.remainingAssets(id), 1);
    }

    function test_buyAndRepay_forceDeallocate_chargesPenaltyToSessionNotBuyer() public {
        _setPenaltyWithoutLiquidityAdapter();
        uint256 id = _openSession(20_000 * USD);
        uint256 debtBefore = _debt(buyer);
        _approveBuyer(type(uint256).max);
        (, uint256 repaid) = _buy(id, 10_100 * USD, PAY_USDC, type(uint256).max, _venue(true, ""));
        assertEq(repaid, 10_000 * USD, "assets / (1 + penalty)");
        assertApproxEqAbs(debtBefore - _debt(buyer), repaid, 1);
        assertApproxEqAbs(market.remainingAssets(id), 9_900 * USD, 5);
        assertEq(_withdrawable(), 0, "liquidity unchanged");
    }

    function test_buyAndRepay_rejectsMarketTheVaultDoesNotSupply() public {
        uint256 id = _openSession(10_000 * USD);
        // The flash market has debt-free USDC liquidity but no vault allocation.
        vm.prank(buyer);
        vm.expectRevert(MorphoVaultExitMarket.WrongMarket.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDC, type(uint256).max, abi.encode(s.flashMarket, false, bytes("")));
    }

    /* ------------------------------ Collateral mode ------------------------------ */

    function test_buyWithCollateral_paysSellerFromFreedCollateral() public {
        uint256 id = _openSession(100_000 * USD);
        vm.warp(block.timestamp + 4 hours); // 3%
        uint256 price = market.quote(60_000 * USD, 300, address(ausd));
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));
        uint256 debtBefore = _debt(buyer);
        vm.prank(buyer);
        (uint256 paid, uint256 repaid) = market.buyAndRepayWithCollateral(id, 60_000 * USD, PAY_AUSD, price, venue);
        assertEq(paid, 58_200 ether);
        assertEq(repaid, 60_000 * USD);
        assertEq(ausd.balanceOf(seller), paid - market.feeOf(paid), "seller got collateral, minus the fee");
        assertApproxEqAbs(debtBefore - _debt(buyer), 60_000 * USD, 1);
        assertFalse(morpho.isAuthorized(buyer, address(market)), "authorization revoked");
        assertEq(usdc.balanceOf(buyer), 300_000 * USD, "buyer spent no cash");
        assertEq(_withdrawable(), 0);
    }

    function test_buyWithCollateral_healthImproves() public {
        uint256 id = _openSession(100_000 * USD);
        // max borrow 344k on 300k debt
        uint256 before = 344_000e6 * 1e18 / _debt(buyer);
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));
        vm.prank(buyer);
        market.buyAndRepayWithCollateral(id, 100_000 * USD, PAY_AUSD, type(uint256).max, venue);
        uint256 collateralLeft = 400_000 ether - market.quote(100_000 * USD, 100, address(ausd));
        uint256 afterHealth = (collateralLeft / 1e12) * 86 / 100 * 1e18 / _debt(buyer);
        assertGt(afterHealth, before);
    }

    function test_buyWithCollateral_requiresSignedRevoke() public {
        uint256 id = _openSession(10_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(MorphoVaultExitMarket.BadAuthorization.selector);
        market.buyAndRepayWithCollateral(id, 1_000 * USD, PAY_AUSD, type(uint256).max, _venue(false, ""));
    }

    function test_buyWithCollateral_rejectsUnderlyingAsPayment() public {
        uint256 id = _openSession(10_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.SamePaymentAsset.selector);
        market.buyAndRepayWithCollateral(id, 1_000 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
    }

    function test_buyWithCollateral_cannotUseSomeoneElsesSignature() public {
        uint256 id = _openSession(10_000 * USD);
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));
        vm.prank(whale);
        vm.expectRevert(MorphoVaultExitMarket.BadAuthorization.selector);
        market.buyAndRepayWithCollateral(id, 1_000 * USD, PAY_AUSD, type(uint256).max, venue);
    }

    /* ------------------------------ Limit bids ------------------------------ */

    function test_placeBid_escrowsAndCountsCapacity() public {
        _placeBid(bidder, 300, 100_000 * USD, 48_500 * USD);
        assertEq(market.totalEscrow(address(usdc)), 48_500 * USD);
        assertEq(market.bidCapacityAt(299), 0);
        assertEq(market.bidCapacityAt(300), 50_000 * USD);
    }

    function test_cancelBid_refundsImmediately() public {
        uint256 id = _placeBid(bidder, 300, 100_000 * USD, 10_000 * USD);
        vm.prank(bidder);
        market.cancelBid(id);
        assertEq(usdc.balanceOf(bidder), 10_000 * USD);
        assertEq(market.totalEscrow(address(usdc)), 0);
        assertEq(market.activeBidIds().length, 0);
    }

    function test_cancelBid_onlyBidder() public {
        uint256 id = _placeBid(bidder, 300, 100_000 * USD, 10_000 * USD);
        vm.prank(seller);
        vm.expectRevert(ExitMarket.NotBidder.selector);
        market.cancelBid(id);
    }

    function test_sellNow_fillsBestBidsFirstAtTheirPrice() public {
        uint256 cheap = _placeBid(bidder, 200, 30_000 * USD, 29_400 * USD);
        uint256 deep = _placeBid(keeper, 800, 100_000 * USD, 92_000 * USD);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        (uint256 filled, uint256[] memory paid) = market.sellNow(50_000 * USD, _ids(cheap, deep), 1000, 0x01, 50_000 * USD);
        vm.stopPrank();
        assertEq(filled, 50_000 * USD);
        assertEq(paid[0], 29_400 * USD);
        assertEq(paid[1], 18_400 * USD);
        assertEq(usdc.balanceOf(seller), 47_704.4e6, "47,800 paid minus a fee per fill");
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(bidder)), 30_000 * USD, 2);
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(keeper)), 20_000 * USD, 2);
        (address cheapBidder,,,,) = market.bids(cheap);
        assertEq(cheapBidder, address(0), "exhausted bid closed");
    }

    function test_sellNow_skipsBidsAboveSellerLimit() public {
        uint256 deep = _placeBid(keeper, 800, 100_000 * USD, 92_000 * USD);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExitMarket.InsufficientFill.selector, 0, 1));
        market.sellNow(50_000 * USD, _ids(deep), 500, 0x01, 1);
        vm.stopPrank();
    }

    function test_matchBid_whenSessionReachesBidDiscount() public {
        uint256 bidId = _placeBid(bidder, 300, 100_000 * USD, 97_000 * USD);
        uint256 id = _openSession(40_000 * USD);
        vm.prank(keeper);
        vm.expectRevert(ExitMarket.DiscountBelowBid.selector);
        market.matchBid(id, bidId, type(uint256).max);
        vm.warp(block.timestamp + 4 hours);
        uint256 remaining = market.remainingAssets(id);
        assertGt(remaining, 40_000 * USD, "escrowed shares keep earning interest");
        vm.prank(keeper);
        (uint256 filled, uint256 paid) = market.matchBid(id, bidId, type(uint256).max);
        assertEq(filled, remaining);
        assertEq(paid, market.quote(remaining, 300, address(usdc)));
        assertEq(usdc.balanceOf(seller), paid - market.feeOf(paid));
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(bidder)), remaining, 3);
        assertLe(market.remainingAssets(id), 1);
    }

    function test_matchBid_paysSessionPriceNotWorse() public {
        uint256 bidId = _placeBid(bidder, 200, 100_000 * USD, 97_000 * USD);
        uint256 id = _openSession(10_000 * USD);
        vm.warp(block.timestamp + 10 hours); // session at 6%, bid accepts >= 2%
        (uint256 filled, uint256 paid) = market.matchBid(id, bidId, type(uint256).max);
        assertApproxEqAbs(paid, filled * 94 / 100, 1, "fills at the session's current discount");
    }

    function test_bid_neverFillsBelowItsDiscount(uint16 sessionStart) public {
        sessionStart = uint16(bound(sessionStart, 0, 299));
        uint256 bidId = _placeBid(bidder, 300, 100_000 * USD, 97_000 * USD);
        ExitMarket.SessionParams memory p = _defaultParams();
        p.startBps = sessionStart;
        p.stepBps = 0;
        uint256 id = _openSession(10_000 * USD, p);
        vm.expectRevert(ExitMarket.DiscountBelowBid.selector);
        market.matchBid(id, bidId, type(uint256).max);
    }

    /* ------------------------------ Recovery ------------------------------ */

    function test_redeemReceipt_onlyWhenLiquid_neverTouchesEscrow() public {
        _openSession(100_000 * USD);
        uint256 shares = vault.previewWithdraw(10_000 * USD);
        vm.prank(seller);
        vault.transfer(bidder, shares);
        vm.prank(bidder);
        vault.approve(address(market), type(uint256).max);
        vm.prank(bidder);
        vm.expectRevert();
        market.redeemReceipt(10_000 * USD, bidder);

        // liquidity returns
        vm.startPrank(whale);
        usdc.approve(address(morpho), 50_000 * USD);
        morpho.repay(s.earnMarket, 50_000 * USD, 0, whale, "");
        vm.stopPrank();
        uint256 units = market.totalSessionUnits();
        vm.prank(bidder);
        market.redeemReceipt(10_000 * USD, bidder);
        assertEq(usdc.balanceOf(bidder), 10_000 * USD);
        assertEq(market.totalSessionUnits(), units);
        assertGe(vault.balanceOf(address(market)), market.totalSessionUnits());
    }

    function test_redeemReceipt_forceDeallocate_chargesPenaltyToRedeemer() public {
        _setPenaltyWithoutLiquidityAdapter();
        assertEq(usdc.balanceOf(address(vault)), 0, "no idle cash");
        _openSession(100_000 * USD);
        uint256 units = market.totalSessionUnits();
        uint256 shares = vault.previewWithdraw(10_000 * USD);
        vm.prank(seller);
        vault.transfer(bidder, shares);
        vm.startPrank(whale);
        usdc.approve(address(morpho), 50_000 * USD);
        morpho.repay(s.earnMarket, 50_000 * USD, 0, whale, "");
        vm.stopPrank();
        vm.startPrank(bidder);
        vault.approve(address(market), type(uint256).max);
        uint256 got = market.redeemReceipt(10_000 * USD, bidder);
        vm.stopPrank();
        assertEq(usdc.balanceOf(bidder), got, "paid to the redeemer");
        assertApproxEqAbs(got, 9_900 * USD, 5, "face value minus the 1% forced-deallocation penalty");
        assertEq(vault.balanceOf(bidder), 0, "the penalty came out of the redeemer's shares");
        assertEq(_earnFreeLiquidity(), 40_000 * USD, "shortfall moved by forced deallocation");
        assertEq(market.totalSessionUnits(), units);
        assertEq(vault.balanceOf(address(market)), market.totalSessionUnits(), "escrow untouched");
    }

    /* ------------------------------ Security (Part 0 S1, S2, S5, S6) ------------------------------ */

    function test_buyAndRepay_liquidityMarketElsewhere_forcesDeallocation() public {
        _cap(vault, abi.encode("this/marketParams", s.adapter, s.flashMarket));
        vault.setLiquidityAdapterAndData(s.adapter, abi.encode(s.flashMarket));
        _depositToVault(keeper, 100_000 * USD);
        uint256 flashShares = morpho.position(s.flashMarket.id(), s.adapter).supplyShares;
        uint256 w = _withdrawable();
        uint256 id = _openSession(100_000 * USD);
        _approveBuyer(type(uint256).max);
        (, uint256 repaid) = _buy(id, 50_000 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
        assertEq(repaid, 50_000 * USD);
        assertEq(
            morpho.position(s.flashMarket.id(), s.adapter).supplyShares,
            flashShares,
            "another market's exit liquidity is untouched"
        );
        assertEq(_earnFreeLiquidity(), 0, "the freed liquidity left the buyer's market by forced deallocation");
        assertEq(_withdrawable(), w);
    }

    function test_buyAndRepay_noLiquidityAdapter_forcesDeallocation() public {
        _setPenaltyWithoutLiquidityAdapter();
        uint256 id = _openSession(20_000 * USD);
        uint256 debtBefore = _debt(buyer);
        _approveBuyer(type(uint256).max);
        (, uint256 repaid) = _buy(id, 10_100 * USD, PAY_USDC, type(uint256).max, _venue(false, ""));
        assertEq(repaid, 10_000 * USD);
        assertApproxEqAbs(debtBefore - _debt(buyer), repaid, 1);
        assertApproxEqAbs(market.remainingAssets(id), 9_900 * USD, 5);
        assertEq(_withdrawable(), 0);
    }

    function test_buyWithCollateral_frontRunGrant_stillSucceeds() public {
        uint256 id = _openSession(100_000 * USD);
        vm.warp(block.timestamp + 4 hours); // 3%
        uint256 n = morpho.nonce(buyer);
        (Authorization memory grant, Signature memory grantSig) = _signAuth(buyerKey, buyer, true, n);
        (Authorization memory revoke, Signature memory revokeSig) = _signAuth(buyerKey, buyer, false, n + 1);
        // The signature is public: someone else submits the grant first.
        vm.prank(whale);
        morpho.setAuthorizationWithSig(grant, grantSig);
        assertTrue(morpho.isAuthorized(buyer, address(market)));
        vm.prank(buyer);
        (uint256 paid,) = market.buyAndRepayWithCollateral(
            id, 60_000 * USD, PAY_AUSD, type(uint256).max, _venue(false, abi.encode(grant, grantSig, revoke, revokeSig))
        );
        assertEq(paid, 58_200 ether);
        assertEq(ausd.balanceOf(seller), paid - market.feeOf(paid), "the purchase did not revert");
        assertFalse(morpho.isAuthorized(buyer, address(market)), "no authorization remains");
        assertEq(morpho.nonce(buyer), n + 2, "the grant was not applied twice");
    }

    function test_resizeBid_keepsIdAndMovesEscrow() public {
        uint256 id = _placeBid(bidder, 300, 100_000 * USD, 10_000 * USD);
        usdc.mint(bidder, 5_000 * USD);
        vm.startPrank(bidder);
        usdc.approve(address(market), 5_000 * USD);
        market.resizeBid(id, 50_000 * USD, 15_000 * USD);
        vm.stopPrank();
        (address b, uint16 minD, uint8 payIdx, uint256 maxAssets, uint256 escrow) = market.bids(id);
        assertEq(b, bidder);
        assertEq(minD, 300);
        assertEq(payIdx, PAY_USDC);
        assertEq(maxAssets, 50_000 * USD);
        assertEq(escrow, 15_000 * USD);
        assertEq(market.totalEscrow(address(usdc)), 15_000 * USD);
        assertEq(usdc.balanceOf(bidder), 0);
        uint256[] memory ids = market.activeBidIds();
        assertEq(ids.length, 1);
        assertEq(ids[0], id);

        vm.prank(bidder);
        market.resizeBid(id, 1_000 * USD, 4_000 * USD);
        assertEq(usdc.balanceOf(bidder), 11_000 * USD, "difference refunded at once");
        assertEq(market.totalEscrow(address(usdc)), 4_000 * USD);
        assertEq(market.bidCapacity(id, 300), 1_000 * USD);

        vm.prank(seller);
        vm.expectRevert(ExitMarket.NotBidder.selector);
        market.resizeBid(id, 1, 1);
        vm.prank(bidder);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.resizeBid(id, 0, 1);
    }

    function test_fills_recordedPerBidderAndPayToken() public {
        uint256 a = _placeBid(bidder, 200, 30_000 * USD, 29_400 * USD);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        market.sellNow(10_000 * USD, _ids(a), 1000, 0x01, 10_000 * USD);
        vm.stopPrank();
        (uint256 units, uint256 paid) = market.fillsOf(bidder, address(usdc));
        assertEq(units, vault.balanceOf(bidder));
        assertEq(paid, 9_800 * USD);

        uint256 sessionId = _openSession(10_000 * USD);
        vm.warp(block.timestamp + 4 hours); // 300 bps
        vm.prank(keeper);
        market.matchBid(sessionId, a, 5_000 * USD);
        (units, paid) = market.fillsOf(bidder, address(usdc));
        assertEq(units, vault.balanceOf(bidder));
        assertEq(paid, 9_800 * USD + 4_850 * USD);
        (uint256 ausdUnits, uint256 ausdPaid) = market.fillsOf(bidder, address(ausd));
        assertEq(ausdUnits, 0);
        assertEq(ausdPaid, 0);

        vm.prank(bidder);
        market.cancelBid(a);
        (uint256 unitsAfter, uint256 paidAfter) = market.fillsOf(bidder, address(usdc));
        assertEq(unitsAfter, units, "kept after the bid closes");
        assertEq(paidAfter, paid, "kept after the bid closes");
    }

    /* ------------------------------ Protocol fee (Part 0 §0.12) ------------------------------ */

    function test_fee_view_roundsDownAndNeedsRecipient() public {
        assertEq(market.FEE_BPS(), 20);
        assertEq(market.feeRecipient(), treasury);
        assertEq(market.feeOf(0), 0);
        assertEq(market.feeOf(499), 0);
        assertEq(market.feeOf(500), 1);
        assertEq(market.feeOf(1_234_567), 2_469, "rounded down");
        assertEq(market.feeOf(49_500e6), 99e6);
        vm.expectRevert(ExitMarket.BadParams.selector);
        new MorphoVaultExitMarket(morpho, vault, s.adapter, prices, _pair(address(usdc), address(ausd)), _uintPair(1, 1), address(0));
    }

    function test_fee_buyAndRepay_buyerPaysQuoteSellerNetsFee() public {
        uint256 id = _openSession(100_000 * USD);
        uint256 price = market.quote(50_000 * USD, market.discountOf(id), address(usdc));
        assertEq(price, 49_500e6);
        _approveBuyer(price);
        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 liquidityBefore = _withdrawable();
        (uint256 paid, uint256 repaid) = _buy(id, 50_000 * USD, PAY_USDC, price, _venue(false, ""));
        assertEq(paid, price);
        assertEq(buyerBefore - usdc.balanceOf(buyer), price, "the buyer pays the quote");
        assertEq(usdc.balanceOf(seller), 49_401e6);
        assertEq(usdc.balanceOf(treasury), 99e6);
        assertEq(repaid, 50_000e6, "the debt repaid does not change with the fee");
        assertEq(_withdrawable(), liquidityBefore);
        assertEq(usdc.balanceOf(address(market)), market.totalEscrow(address(usdc)), "no fee stays in the market");
    }

    function test_fee_buyWithCollateral_splitsFreedCollateral() public {
        uint256 id = _openSession(100_000 * USD);
        vm.warp(block.timestamp + 4 hours); // 3%
        uint256 c0 = morpho.position(s.earnMarket.id(), buyer).collateral;
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));
        vm.prank(buyer);
        (uint256 paid, uint256 repaid) =
            market.buyAndRepayWithCollateral(id, 60_000 * USD, PAY_AUSD, type(uint256).max, venue);
        assertEq(paid, 58_200 ether);
        assertEq(c0 - morpho.position(s.earnMarket.id(), buyer).collateral, paid, "the freed collateral pays the quote");
        assertEq(ausd.balanceOf(seller), 58_083.6 ether);
        assertEq(ausd.balanceOf(treasury), 116.4 ether);
        assertEq(ausd.balanceOf(address(market)), 0, "the collateral passes through the market");
        assertEq(repaid, 60_000e6);
        assertFalse(morpho.isAuthorized(buyer, address(market)));
    }

    function test_fee_sellNow_perFillRoundedDown() public {
        uint256 dust = _placeBid(keeper, 0, 499, 499);
        uint256 odd = _placeBid(bidder, 0, 1_234_567, 1_234_567);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        (uint256 filled, uint256[] memory paid) = market.sellNow(1_235_066, _ids(dust, odd), 0, 0x01, 1_235_066);
        vm.stopPrank();
        assertEq(filled, 1_235_066);
        assertEq(paid[0], 499);
        assertEq(paid[1], 1_234_567);
        assertEq(usdc.balanceOf(seller), 1_232_597);
        assertEq(usdc.balanceOf(treasury), 2_469, "the 499-unit fill pays no fee and the other is rounded down");
        (, uint256 keeperPaid) = market.fillsOf(keeper, address(usdc));
        (, uint256 bidderPaid) = market.fillsOf(bidder, address(usdc));
        assertEq(keeperPaid, 499, "fills record the whole payment");
        assertEq(bidderPaid, 1_234_567, "fills record the whole payment");
        (address dustBidder,,,,) = market.bids(dust);
        (address oddBidder,,,,) = market.bids(odd);
        assertEq(dustBidder, address(0));
        assertEq(oddBidder, address(0));
    }

    function test_fee_matchBid_escrowPaysFullPriceSellerNets() public {
        uint256 bidId = _placeBid(bidder, 300, 100_000 * USD, 97_000 * USD);
        uint256 id = _openSession(40_000 * USD);
        vm.warp(block.timestamp + 4 hours); // 300 bps
        vm.prank(keeper);
        (uint256 filled, uint256 paid) = market.matchBid(id, bidId, type(uint256).max);
        assertEq(paid, market.quote(filled, 300, address(usdc)));
        assertEq(usdc.balanceOf(seller), paid - market.feeOf(paid));
        assertEq(usdc.balanceOf(treasury), market.feeOf(paid));
        (,,,, uint256 escrow) = market.bids(bidId);
        assertEq(escrow, 97_000 * USD - paid, "the escrow pays the full price; the fee comes out of the seller's side");
        (, uint256 fillPaid) = market.fillsOf(bidder, address(usdc));
        assertEq(fillPaid, paid);
    }
}
