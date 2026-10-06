// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";

contract SelioVaultMorphoTest is MorphoBase {
    SelioVault internal ev;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        ev = _newVault();
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(ev), amount);
        shares = ev.deposit(amount, who, 0);
        vm.stopPrank();
    }

    function _redeemAll(address who)
        internal
        returns (uint256 assets, uint256[] memory receipts, uint256 shares)
    {
        shares = ev.balanceOf(who);
        vm.prank(who);
        (assets, receipts,) = ev.redeem(shares, who, who, new uint256[](0));
    }

    function _activeBid() internal view returns (uint256 id, uint256 escrow, uint256 maxAssets, uint16 minD) {
        id = ev.bidOf(0);
        (, minD,, maxAssets, escrow) = market.bids(id);
    }

    function _sellIntoVault(uint256 assets, uint256 minFilled) internal returns (uint256 filled) {
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        (filled,) = market.sellNow(assets, _ids(ev.bidOf(0)), 500, 0x01, minFilled);
        vm.stopPrank();
    }

    function _unfreeze(uint256 amount) internal {
        vm.startPrank(whale);
        usdc.approve(address(morpho), amount);
        morpho.repay(s.earnMarket, amount, 0, whale, "");
        vm.stopPrank();
    }

    function test_deposit_placesRuleBasedBid() public {
        _deposit(alice, 100_000 * USD);
        (uint256 id, uint256 escrow, uint256 maxAssets, uint16 minD) = _activeBid();
        assertGt(id, 0);
        assertEq(minD, 300, "min discount");
        assertEq(escrow, 20_000 * USD, "20% of capital");
        assertEq(maxAssets, 20_000 * USD);
        assertEq(ev.totalAssets(), 100_000 * USD);
        assertEq(ev.idleAssets(), 100_000 * USD);
        assertEq(usdc.balanceOf(address(ev)), 80_000 * USD, "rest stays idle outside the pool");
    }

    function test_vaultCapitalNeverEntersProtectedPool() public {
        _deposit(alice, 100_000 * USD);
        assertEq(vault.balanceOf(address(ev)), 0, "no Earn shares minted by deposits");
    }

    function test_sellerSellsIntoVault_vaultHoldsReceipts() public {
        _deposit(alice, 100_000 * USD);
        uint256 filled = _sellIntoVault(30_000 * USD, 1);
        assertEq(filled, 20_000 * USD, "capped at 20%");
        assertEq(usdc.balanceOf(seller), 19_361.2e6, "3% discount, minus the 0.2% fee");
        assertEq(usdc.balanceOf(treasury), 38.8e6);
        assertApproxEqAbs(ev.heldAssets(0), 20_000 * USD, 2);
        assertEq(ev.heldCost(0), 19_400e6, "the vault's cost basis is the whole payment");
        assertEq(ev.totalAssets(), 100_000 * USD, "bought receipts count at cost until they are recovered");
        ev.refreshBids();
        (, uint256 escrow,,) = _activeBid();
        assertEq(escrow, 600e6, "cap minus the cost of the receipts already bought");
    }

    function test_redeem_inKind_beforeRecovery() public {
        _deposit(alice, 100_000 * USD);
        _deposit(bob, 100_000 * USD);
        _sellIntoVault(40_000 * USD, 1);
        uint256 earnShares = vault.balanceOf(address(ev));
        (uint256 assets, uint256[] memory receipts,) = _redeemAll(alice);
        assertApproxEqRel(assets, 80_600 * USD, 1e12, "half of idle");
        assertApproxEqRel(receipts[0], earnShares / 2, 1e8, "half of receipts in kind");
        assertLe(receipts[0], earnShares / 2);
        assertEq(vault.balanceOf(alice), receipts[0]);
        assertEq(usdc.balanceOf(alice), assets);
    }

    function test_redeem_allowanceForThirdParty() public {
        uint256 shares = _deposit(alice, 1_000 * USD);
        vm.prank(bob);
        vm.expectRevert();
        ev.redeem(shares, bob, alice, new uint256[](0));
        vm.prank(alice);
        ev.approve(bob, shares);
        vm.prank(bob);
        ev.redeem(shares, bob, alice, new uint256[](0));
        assertApproxEqAbs(usdc.balanceOf(bob), 1_000 * USD, 1);
    }

    function test_recover_permissionless_afterPoolUnfreezes() public {
        _deposit(alice, 100_000 * USD);
        _sellIntoVault(20_000 * USD, 1);
        vm.expectRevert();
        ev.recover(0, type(uint256).max);
        _unfreeze(100_000 * USD);
        vm.prank(keeper);
        ev.recover(0, type(uint256).max);
        assertLe(ev.heldAssets(0), 1);
        assertApproxEqAbs(ev.totalAssets(), 100_600 * USD, 3, "profit realised in USDC");
    }

    function test_matchBid_sessionHitsVaultBid() public {
        _deposit(alice, 100_000 * USD);
        uint256 sessionId = _openSession(10_000 * USD);
        vm.warp(block.timestamp + 4 hours);
        market.matchBid(sessionId, ev.bidOf(0), type(uint256).max);
        assertGt(ev.heldAssets(0), 10_000 * USD - 1);
    }

    function test_constructor_rejectsDifferentDenomination() public {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        vm.expectRevert(SelioVault.BadParams.selector);
        new SelioVault(
            "x", "x", IERC20(address(ausd)), markets, minD, maxShare, IERC4626(address(0)), ISourceProbe(address(0))
        );
    }

    function testFuzz_depositRedeem_noValueCreated(uint96 a, uint96 b) public {
        uint256 x = bound(a, 1e6, 10_000_000e6);
        uint256 y = bound(b, 1e6, 10_000_000e6);
        _deposit(alice, x);
        _deposit(bob, y);
        (uint256 out,,) = _redeemAll(alice);
        assertLe(out, x, "never more than deposited");
        assertApproxEqAbs(out, x, 2, "fair share");
    }

    /* ------------------------------ Security (Part 0 S1, S2, S3, S11) ------------------------------ */

    function test_donatedReceipts_ignoredByPriceAndCap() public {
        _deposit(alice, 100_000 * USD);
        uint256 ta = ev.totalAssets();
        uint256 pd = ev.previewDeposit(1_000e6);
        (uint256 id, uint256 escrow, uint256 maxAssets,) = _activeBid();
        uint256 donated = vault.previewWithdraw(50_000 * USD);
        vm.prank(seller);
        vault.transfer(address(ev), donated);
        assertEq(ev.totalAssets(), ta, "a donation does not move the share price");
        assertEq(ev.previewDeposit(1_000e6), pd, "a donation does not move the share price");
        assertEq(ev.heldUnits(0), 0);
        assertEq(ev.heldCost(0), 0);
        assertEq(ev.heldAssets(0), 0);
        ev.refreshBids();
        (uint256 idAfter, uint256 escrowAfter, uint256 maxAfter,) = _activeBid();
        assertEq(idAfter, id);
        assertEq(escrowAfter, escrow, "the cap ignores donated receipts");
        assertEq(maxAfter, maxAssets, "the cap ignores donated receipts");
        vm.expectRevert(SelioVault.ZeroAmount.selector);
        ev.recover(0, type(uint256).max);
        uint256 aliceShares = ev.balanceOf(alice);
        (uint256 assets, uint256[] memory receipts,) = _redeemAll(alice);
        assertEq(receipts[0], donated * aliceShares / (aliceShares + 1000), "paid out pro rata in kind");
        assertApproxEqAbs(assets, 100_000 * USD, 1);
    }

    function test_donationAttack_victimKeepsValue() public {
        address mallory = makeAddr("mallory");
        _deposit(mallory, 1_000 * USD);
        uint256 donation = vault.previewWithdraw(100_000 * USD);
        vm.prank(seller);
        vault.transfer(mallory, donation);
        vm.prank(mallory);
        vault.transfer(address(ev), donation);

        uint256 minShares = ev.previewDeposit(10_000e6);
        usdc.mint(bob, 10_000 * USD);
        vm.startPrank(bob);
        usdc.approve(address(ev), 10_000 * USD);
        uint256 bobShares = ev.deposit(10_000 * USD, bob, minShares);
        vm.stopPrank();
        assertEq(bobShares, minShares);
        assertApproxEqAbs(bobShares, ev.balanceOf(mallory) * 10, 1, "same price as without the donation");

        _redeemAll(mallory);
        assertLe(usdc.balanceOf(mallory), 1_000 * USD, "the attacker gets no more cash than she put in");
        (uint256 bobAssets, uint256[] memory bobReceipts,) = ev.previewRedeem(bobShares);
        assertGe(bobAssets, 10_000 * USD - 2, "the victim's cash is intact");
        assertGt(bobReceipts[0], 0);
    }

    function test_deposit_revertsBelowMinShares() public {
        uint256 p = ev.previewDeposit(1_000e6);
        usdc.mint(alice, 1_000 * USD);
        vm.startPrank(alice);
        usdc.approve(address(ev), 1_000 * USD);
        vm.expectRevert(abi.encodeWithSelector(SelioVault.InsufficientShares.selector, p, p + 1));
        ev.deposit(1_000e6, alice, p + 1);
        assertEq(ev.deposit(1_000e6, alice, p), p);
        vm.stopPrank();
    }

    function test_bidId_stableAcrossDepositRedeemRefresh() public {
        _deposit(alice, 100_000 * USD);
        (uint256 id, uint256 escrow,,) = _activeBid();
        assertEq(escrow, 20_000 * USD);
        _deposit(bob, 50_000 * USD);
        (uint256 id2, uint256 escrow2,,) = _activeBid();
        assertEq(id2, id);
        assertEq(escrow2, 30_000 * USD);
        ev.refreshBids();
        assertEq(ev.bidOf(0), id);
        uint256 half = ev.balanceOf(alice) / 2;
        vm.prank(alice);
        ev.redeem(half, alice, alice, new uint256[](0));
        (uint256 id3, uint256 escrow3,,) = _activeBid();
        assertEq(id3, id);
        assertApproxEqAbs(escrow3, 20_000 * USD, 1);
        assertEq(market.activeBidIds().length, 1, "no stale bid left behind");
        // A sale built from the id read before Bob's deposit still fills.
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(10_000 * USD, _ids(id), 500, 0x01, 10_000 * USD);
        vm.stopPrank();
        assertEq(filled, 10_000e6, "a pending sellNow still fills");
    }

    function test_redeem_skipList_paysIdleAndKeepsClaimable() public {
        uint256 aliceShares = _deposit(alice, 100_000 * USD);
        _sellIntoVault(20_000 * USD, 1);
        (, uint256[] memory expected,) = ev.previewRedeem(aliceShares);
        // Every Earn share transfer to alice reverts, as a gated share would.
        vm.mockCallRevert(address(vault), abi.encodeWithSelector(IERC20.transfer.selector, alice), "");
        vm.prank(alice);
        vm.expectRevert();
        ev.redeem(aliceShares, alice, alice, new uint256[](0));
        vm.prank(alice);
        (uint256 assets, uint256[] memory receipts,) = ev.redeem(aliceShares, alice, alice, _ids(0));
        assertEq(receipts[0], 0);
        assertEq(usdc.balanceOf(alice), assets);
        assertApproxEqRel(assets, 80_600 * USD, 1e12, "idle cash paid");
        assertEq(ev.claimable(alice, 0), expected[0]);
        assertEq(ev.totalClaimable(0), expected[0]);
        assertEq(vault.balanceOf(alice), 0);
        vm.clearMockedCalls();
        vm.prank(alice);
        assertEq(ev.claim(0, alice), expected[0]);
        assertEq(vault.balanceOf(alice), expected[0]);
        assertEq(ev.claimable(alice, 0), 0);
        vm.prank(alice);
        vm.expectRevert(SelioVault.ZeroAmount.selector);
        ev.claim(0, alice);
    }

    function test_cap_clippedOnFill_heldAtCost() public {
        _deposit(alice, 100_000 * USD);
        _sellIntoVault(10_000 * USD, 1);
        assertEq(ev.heldCost(0), 9_700e6);
        // The earn market's borrowers accrue interest, so the Earn shares the vault holds gain value.
        vm.warp(block.timestamp + 30 days);
        uint256 filled = _sellIntoVault(50_000 * USD, 1);
        assertEq(filled, 10_000e6, "clipped at the room left under the cap");
        assertEq(ev.heldCost(0), 19_400e6);
        assertLe(ev.heldCost(0), ev.totalAssets() * 2_000 / 10_000);
        assertEq(ev.totalAssets(), 100_000 * USD, "receipt interest does not move the cap measure");
        assertGt(ev.heldAssets(0), 20_000 * USD);
    }
}
