// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";

/// @notice Every guard path of the market and vault, so reverts are deliberate and specific.
contract GuardsTest is MorphoBase {
    function _vault() internal returns (SelioVault ev) {
        ev = _newVault();
    }

    function _vaultWith(ExitMarket[] memory markets, uint16[] memory minD, uint16[] memory maxShare)
        internal
        returns (SelioVault)
    {
        return new SelioVault(
            "x",
            "x",
            IERC20(address(usdc)),
            markets,
            minD,
            maxShare,
            IERC4626(address(0)),
            ISourceProbe(address(0)),
            _noKuru(markets.length),
            5_000
        );
    }

    function test_openSession_paramGuards() public {
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        ExitMarket.SessionParams memory p = _defaultParams();
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.openSession(0, p);

        p = _defaultParams();
        p.startBps = 2000; // above cap
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);

        p = _defaultParams();
        p.stepInterval = 0;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);

        p = _defaultParams();
        p.duration = 31 days;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);

        p = _defaultParams();
        p.duration = 0;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);

        p = _defaultParams();
        p.payMask = 0;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);
        vm.stopPrank();
    }

    function test_withdrawUnsold_amountGuards() public {
        uint256 id = _openSession(1_000 * USD);
        (,,,,,,,, uint256 units) = market.sessions(id);
        vm.startPrank(seller);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.withdrawUnsold(id, 0);
        vm.expectRevert(ExitMarket.NotEnoughUnits.selector);
        market.withdrawUnsold(id, units + 1);
        market.withdrawUnsold(id, units / 2);
        vm.stopPrank();
        assertEq(market.totalSessionUnits(), units - units / 2);
    }

    function test_discountOf_unknownSessionIsZero() public view {
        assertEq(market.discountOf(999), 0);
        assertFalse(market.isOpen(999));
    }

    function test_bidGuards() public {
        vm.startPrank(bidder);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.placeBid(100, 0, 0, 1);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.placeBid(100, 0, 1, 0);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.placeBid(5001, 0, 1, 1);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.placeBid(100, 2, 1, 1);
        vm.expectRevert(ExitMarket.NotBidder.selector);
        market.cancelBid(42);
        vm.stopPrank();
        assertEq(market.bidCapacity(42, 100), 0);
    }

    function test_matchBid_guards() public {
        uint256 id = _openSession(1_000 * USD);
        vm.expectRevert(ExitMarket.UnknownBid.selector);
        market.matchBid(id, 7, 1);

        usdc.mint(bidder, 1_000 * USD);
        ausd.mint(bidder, 1_000 ether);
        vm.startPrank(bidder);
        usdc.approve(address(market), type(uint256).max);
        ausd.approve(address(market), type(uint256).max);
        uint256 bidAusd = market.placeBid(0, PAY_AUSD, 1_000 * USD, 1_000 ether);
        uint256 bidUsdc = market.placeBid(0, PAY_USDC, 1_000 * USD, 500 * USD);
        vm.stopPrank();

        ExitMarket.SessionParams memory p = _defaultParams();
        p.payMask = 0x01;
        uint256 usdcOnly = _openSession(1_000 * USD, p);
        vm.expectRevert(ExitMarket.PayTokenNotAccepted.selector);
        market.matchBid(usdcOnly, bidAusd, type(uint256).max);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.matchBid(usdcOnly, bidUsdc, 0);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(ExitMarket.SessionClosed.selector);
        market.matchBid(id, bidUsdc, type(uint256).max);
    }

    function test_matchBid_partialByAssetsArgument() public {
        usdc.mint(bidder, 10_000 * USD);
        vm.startPrank(bidder);
        usdc.approve(address(market), type(uint256).max);
        uint256 bidId = market.placeBid(100, PAY_USDC, 10_000 * USD, 9_900 * USD);
        vm.stopPrank();
        uint256 id = _openSession(5_000 * USD);
        (uint256 filled,) = market.matchBid(id, bidId, 1_000 * USD);
        assertEq(filled, 1_000 * USD);
        assertApproxEqAbs(market.remainingAssets(id), 4_000 * USD, 2);
    }

    function test_sellNow_zeroAndSkips() public {
        uint256[] memory ids = _ids(77); // unknown bid is skipped
        vm.startPrank(seller);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.sellNow(0, ids, 100, 0x01, 0);
        (uint256 filled,) = market.sellNow(1_000 * USD, ids, 100, 0x01, 0);
        vm.stopPrank();
        assertEq(filled, 0);
    }

    function test_redeemReceipt_zero() public {
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.redeemReceipt(0, address(this));
    }

    function test_flashCallback_cannotBeCalledDirectly() public {
        vm.expectRevert(MorphoVaultExitMarket.UnexpectedCallback.selector);
        market.onMorphoFlashLoan(1, "");
        vm.prank(address(morpho));
        vm.expectRevert(MorphoVaultExitMarket.UnexpectedCallback.selector);
        market.onMorphoFlashLoan(1, "");
    }

    function test_views() public {
        assertEq(market.payTokens().length, 2);
        _openSession(1_000 * USD);
        assertApproxEqAbs(market.capacity().sessionAssets, 1_000 * USD, 2);
        assertEq(market.receiptValue(vault.balanceOf(address(market))), market.remainingAssets(1));
    }

    function test_constructor_rejectsForeignAdapter() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdc);
        uint256[] memory minEscrows = new uint256[](1);
        minEscrows[0] = 1;
        vm.expectRevert();
        new MorphoVaultExitMarket(morpho, vault, address(0xBEEF), prices, tokens, minEscrows, treasury);
    }

    function test_vault_guardsAndViews() public {
        SelioVault ev = _vault();
        assertEq(ev.decimals(), 9);
        assertEq(ev.strategiesLength(), 1);
        assertEq(address(ev.strategy(0).market), address(market));
        vm.expectRevert(SelioVault.ZeroAmount.selector);
        ev.deposit(0, address(this), 0);
        vm.expectRevert(SelioVault.ZeroShares.selector);
        ev.redeem(0, address(this), address(this), new uint256[](0));
        vm.expectRevert(SelioVault.ZeroAmount.selector);
        ev.recover(0, 1);
        ev.refreshBids(); // nothing to bid with: no-op
        assertEq(ev.bidOf(0), 0);
    }

    function test_vault_constructorGuards() public {
        ExitMarket[] memory two = new ExitMarket[](2);
        two[0] = market;
        two[1] = market;
        uint16[] memory minD = new uint16[](2);
        uint16[] memory maxShare = new uint16[](2);
        maxShare[0] = 1000;
        maxShare[1] = 1000;
        vm.expectRevert(SelioVault.BadParams.selector); // duplicate receipt
        _vaultWith(two, minD, maxShare);

        uint16[] memory oneShare = new uint16[](1);
        oneShare[0] = 1000;
        vm.expectRevert(SelioVault.BadParams.selector); // length mismatch
        _vaultWith(two, minD, oneShare);

        ExitMarket[] memory one = new ExitMarket[](1);
        one[0] = market;
        uint16[] memory oneMin = new uint16[](1);
        uint16[] memory zeroShare = new uint16[](1);
        vm.expectRevert(SelioVault.BadParams.selector); // zero max share
        _vaultWith(one, oneMin, zeroShare);
    }

    function test_vault_kuruGuards() public {
        ExitMarket[] memory one = new ExitMarket[](1);
        one[0] = market;
        uint16[] memory minD = new uint16[](1);
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        // One Kuru leg per strategy, and at most the whole room on Kuru.
        vm.expectRevert(SelioVault.BadParams.selector);
        new SelioVault(
            "x", "x", IERC20(address(usdc)), one, minD, maxShare, IERC4626(address(0)), ISourceProbe(address(0)), _noKuru(2), 0
        );
        vm.expectRevert(SelioVault.BadParams.selector);
        new SelioVault(
            "x",
            "x",
            IERC20(address(usdc)),
            one,
            minD,
            maxShare,
            IERC4626(address(0)),
            ISourceProbe(address(0)),
            _noKuru(1),
            10_001
        );
        SelioVault ev = _vault();
        vm.expectRevert(SelioVault.NotSelf.selector);
        ev.kuruOp(0, 0, 0, 0);
        vm.expectRevert(SelioVault.NotSelf.selector);
        ev.kuruOp(1, 0, 970_000, 1e6);
        vm.expectRevert(SelioVault.NothingToClaim.selector);
        ev.claimKuru(0, address(this));
        // A disabled leg reads as empty.
        (address book,,, uint40 orderId,,, uint256 escrow,) = ev.kuruLeg(0);
        assertEq(book, address(0));
        assertEq(orderId, 0);
        assertEq(escrow, 0);
        (bool active,, uint256 refund, uint256 pending) = ev.kuruOrderState(0);
        assertFalse(active);
        assertEq(refund + pending, 0);
    }

    function test_vault_bidClosedByAFullFillIsHandled() public {
        SelioVault ev = _vault();
        usdc.mint(address(this), 10_000 * USD);
        usdc.approve(address(ev), type(uint256).max);
        ev.deposit(10_000 * USD, address(this), 0);
        uint256 bidId = ev.bidOf(0);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        market.sellNow(100_000 * USD, _ids(bidId), 500, 0x01, 0);
        vm.stopPrank();
        (address b,,,,) = market.bids(bidId);
        assertEq(b, address(0), "exhausted bid closed by the market");
        ev.refreshBids(); // must skip the closed bid instead of reverting
        assertGt(ev.heldAssets(0), 0);
    }

    /* ------------------------------ Security (Part 0 S7) ------------------------------ */

    function test_placeBid_rejectsDustBids() public {
        usdc.mint(bidder, 1_000 * USD);
        ausd.mint(bidder, 1_000 ether);
        vm.startPrank(bidder);
        usdc.approve(address(market), type(uint256).max);
        ausd.approve(address(market), type(uint256).max);
        // 1 wei of AUSD-sim buys 0 USDC of receipt value.
        vm.expectRevert(ExitMarket.BidTooSmall.selector);
        market.placeBid(0, PAY_AUSD, 1_000 * USD, 1);
        vm.stopPrank();

        uint256[] memory minimums = _uintPair(100e6, 100 ether);
        MorphoVaultExitMarket m = new MorphoVaultExitMarket(
            morpho, vault, s.adapter, prices, _pair(address(usdc), address(ausd)), minimums, treasury
        );
        vm.startPrank(bidder);
        usdc.approve(address(m), type(uint256).max);
        assertEq(m.minEscrowOf(address(usdc)), 100e6);
        vm.expectRevert(ExitMarket.BidTooSmall.selector);
        m.placeBid(100, PAY_USDC, 1_000 * USD, 100e6 - 1);
        uint256 bidId = m.placeBid(100, PAY_USDC, 1_000 * USD, 100e6);
        vm.expectRevert(ExitMarket.BidTooSmall.selector);
        m.resizeBid(bidId, 1_000 * USD, 99e6);
        vm.stopPrank();
        assertEq(market.activeBidIds().length, 0, "no dust bid listed");
    }

    function test_activeBids_paginated() public {
        usdc.mint(bidder, 3_000 * USD);
        vm.startPrank(bidder);
        usdc.approve(address(market), type(uint256).max);
        uint256 a = market.placeBid(100, PAY_USDC, 1_000 * USD, 1_000 * USD);
        uint256 b = market.placeBid(200, PAY_USDC, 1_000 * USD, 1_000 * USD);
        uint256 c = market.placeBid(300, PAY_USDC, 1_000 * USD, 1_000 * USD);
        vm.stopPrank();
        assertEq(market.activeBidCount(), 3);
        uint256[] memory page = market.activeBidIdsPage(0, 2);
        assertEq(page.length, 2);
        assertEq(page[0], a);
        assertEq(page[1], b);
        page = market.activeBidIdsPage(2, 5);
        assertEq(page.length, 1);
        assertEq(page[0], c);
        assertEq(market.activeBidIdsPage(3, 1).length, 0);
        assertEq(
            market.bidCapacityAtPage(300, 0, 2) + market.bidCapacityAtPage(300, 2, 2), market.bidCapacityAt(300)
        );
        assertEq(market.bidCapacityAtPage(300, 9, 1), 0);
        vm.prank(bidder);
        market.cancelBid(a);
        page = market.activeBidIdsPage(0, 3);
        assertEq(page.length, 2);
        assertEq(page[0], c, "swap-and-pop order");
        assertEq(page[1], b);
    }
}
