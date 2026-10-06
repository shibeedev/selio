// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {AaveForkBase} from "./AaveForkBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {AaveExitMarket} from "../../src/venues/aave/AaveExitMarket.sol";
import {AnswerOnlyFeed, IAnswerAggregator} from "../../src/shared/oracle/AnswerOnlyFeed.sol";
import {IPriceFeed} from "../../src/shared/interfaces/IPriceFeed.sol";

contract AaveExitMarketForkTest is AaveForkBase {
    /// @dev Rounding slack of the remaining session value after a looped Aave-flash buy (base units).
    uint256 internal constant S = 20;

    function _payAusd(uint256 amount) internal {
        _dealAusd(buyer, amount);
        vm.prank(buyer);
        IERC20(AUSD).approve(address(market), amount);
    }

    function test_fork_capacityReadsLivePool() public {
        // Live utilization moves with the market, so first raise it the way `_freeze` does (5% left withdrawable).
        _freeze(IERC20(A_USDC).totalSupply() / 20);
        ExitMarket.Capacity memory c = market.capacity();
        assertEq(c.withdrawable, _usdcLiquidity());
        assertEq(c.supplied, IERC20(A_USDC).totalSupply());
        assertGt(c.utilizationBps, 9_000);
        assertEq(c.debtorCapacity, IERC20(V_USDC).totalSupply());
    }

    function test_fork_partialLiquidity_aaveFlashLoops_keepLiquidity() public {
        _scene(5e6);
        uint256 id = _openSession(80e6);
        uint256 liquidityBefore = _usdcLiquidity();
        uint256 debtBefore = _debt(buyer);
        uint256 sellerBefore = IERC20(AUSD).balanceOf(seller);
        uint256 price = market.quote(50e6, market.discountOf(id), AUSD);
        _payAusd(price);
        vm.prank(buyer);
        (uint256 paid, uint256 repaid) = market.buyAndRepay(id, 50e6, PAY_AUSD, price, "");
        assertEq(IERC20(AUSD).balanceOf(seller) - sellerBefore, paid - market.feeOf(paid));
        assertLt(repaid, 50e6, "Aave flash premium deducted");
        assertApproxEqRel(repaid, 50e6, 0.001e18);
        // Each repay round rounds the debt-token burn in Aave's favour by a few base units.
        assertApproxEqAbs(debtBefore - _debt(buyer), repaid, 100);
        assertApproxEqAbs(_usdcLiquidity(), liquidityBefore, 1);
        // Aave adds the LP part of the flash premium to the liquidity index, so escrowed aMonUSDC gains a little.
        uint256 remaining = market.remainingAssets(id);
        assertGe(remaining, 30e6 - S);
        assertApproxEqRel(remaining, 30e6, 0.00001e18);
        assertGe(IERC20(A_USDC).balanceOf(address(market)) + 1, remaining);
    }

    function test_fork_fullyFrozen_revertsWithoutExternalSource() public {
        _scene(0);
        uint256 id = _openSession(80e6);
        _payAusd(1_000_000e6);
        vm.prank(buyer);
        IERC20(AUSD).approve(address(market), type(uint256).max);
        vm.prank(buyer);
        vm.expectRevert(AaveExitMarket.NoFlashLiquidity.selector);
        market.buyAndRepay(id, 10e6, PAY_AUSD, type(uint256).max, "");
    }

    function test_fork_fullyFrozen_externalFlash_paysSellerAusd() public {
        market = _deployMarket(IMorpho(MORPHO));
        _scene(0);
        assertEq(_usdcLiquidity(), 0, "pool frozen at 100%");
        uint256 id = _openSession(80e6);
        vm.warp(block.timestamp + 6 hours);
        uint256 price = market.quote(60e6, 400, AUSD);
        uint256 debtBefore = _debt(buyer);
        uint256 morphoBefore = IERC20(USDC).balanceOf(MORPHO);
        _payAusd(price);
        vm.prank(buyer);
        (, uint256 repaid) = market.buyAndRepay(id, 60e6, PAY_AUSD, price, "");
        assertEq(repaid, 60e6, "external flash is free");
        assertApproxEqAbs(debtBefore - _debt(buyer), 60e6, 100, "debt burn rounds in Aave's favour");
        assertEq(_usdcLiquidity(), 0, "still exactly 0 withdrawable");
        assertEq(IERC20(AUSD).balanceOf(seller), price - market.feeOf(price));
        assertEq(IERC20(USDC).balanceOf(MORPHO), morphoBefore, "flash returned");
    }

    function test_fork_payWithCollateral_weth() public {
        _scene(5e6);
        uint256 id = _openSession(80e6);
        uint256 price = market.quote(40e6, market.discountOf(id), WETH);
        uint256 hfBefore = _hf(buyer);
        uint256 collateralBefore = IERC20(A_WETH).balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20(A_WETH).approve(address(market), price + market.collateralPullMargin(WETH));
        (uint256 paid,) = market.buyAndRepayWithCollateral(id, 40e6, PAY_WETH, price, "");
        vm.stopPrank();
        assertEq(IERC20(A_WETH).balanceOf(address(market)), 0, "rounding margin refunded");
        assertEq(IERC20(WETH).balanceOf(seller), paid - market.feeOf(paid), "seller receives WETH, minus the fee");
        assertApproxEqAbs(collateralBefore - IERC20(A_WETH).balanceOf(buyer), paid, 2);
        assertGt(_hf(buyer), hfBefore, "health factor improves");
        assertEq(IERC20(WETH).balanceOf(buyer), 0, "no cash needed");
    }

    function test_fork_payWithCollateral_requiresApproval() public {
        _scene(5e6);
        uint256 id = _openSession(80e6);
        vm.prank(buyer);
        vm.expectRevert();
        market.buyAndRepayWithCollateral(id, 10e6, PAY_WETH, type(uint256).max, "");
    }

    function test_fork_sellNow_intoAusdBid_andRedeemLater() public {
        _scene(0);
        uint256 escrow = market.quote(10e6, 500, AUSD);
        _dealAusd(bidder, escrow);
        vm.startPrank(bidder);
        IERC20(AUSD).approve(address(market), escrow);
        uint256 bidId = market.placeBid(500, PAY_AUSD, 10e6, escrow);
        vm.stopPrank();
        vm.startPrank(seller);
        IERC20(A_USDC).approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(10e6, _ids(bidId), 500, 0x01, 10e6);
        vm.stopPrank();
        assertEq(filled, 10e6);
        assertApproxEqAbs(IERC20(AUSD).balanceOf(seller), escrow - market.feeOf(escrow), 1);
        assertApproxEqAbs(IERC20(A_USDC).balanceOf(bidder), 10e6, 5);

        _unfreeze(50e6);
        vm.startPrank(bidder);
        IERC20(A_USDC).approve(address(market), type(uint256).max);
        uint256 got = market.redeemReceipt(9.9e6, bidder);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(bidder), got);
        assertApproxEqAbs(got, 9.9e6, 10, "face value within Aave rounding");
    }

    function test_fork_withdrawUnsold_returnsATokens() public {
        _scene(5e6);
        uint256 before = IERC20(A_USDC).balanceOf(seller);
        uint256 id = _openSession(50e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(seller);
        uint256 back = market.withdrawUnsold(id, type(uint256).max);
        assertGe(back, 50e6, "interest kept accruing while escrowed");
        assertGe(IERC20(A_USDC).balanceOf(seller), before, "all receipts returned");
        assertEq(market.totalSessionUnits(), 0);
    }

    function test_fork_flashCallbacks_rejectSpoofedCalls() public {
        vm.expectRevert(AaveExitMarket.UnexpectedCallback.selector);
        market.executeOperation(USDC, 1, 0, address(market), "");
        vm.prank(address(POOL));
        vm.expectRevert(AaveExitMarket.UnexpectedCallback.selector);
        market.executeOperation(USDC, 1, 0, address(this), "");
        vm.expectRevert(AaveExitMarket.UnexpectedCallback.selector);
        market.onMorphoFlashLoan(1, "");
    }

    function test_fork_constructor_rejectsMismatchedCollateralAToken() public {
        address[] memory payTokens = new address[](2);
        (payTokens[0], payTokens[1]) = (WETH, USDC);
        address[] memory payATokens = new address[](2);
        payATokens[0] = A_USDC; // aMonUSDC given as WETH's aToken
        uint256[] memory minEscrows = new uint256[](2);
        (minEscrows[0], minEscrows[1]) = (1, 1);
        vm.expectRevert(ExitMarket.BadParams.selector);
        new AaveExitMarket(POOL, A_USDC, V_USDC, prices, payTokens, payATokens, IMorpho(address(0)), minEscrows, treasury);
    }

    function test_fork_flashCapacity_andReceiptValue() public view {
        (uint256 aaveChunk, uint256 extChunk) = market.flashCapacity();
        assertGt(aaveChunk, 0);
        assertEq(extChunk, 0);
        assertEq(market.receiptValue(1e6), 1e6);
    }

    /* ------------------------------ Security (Part 0 S4, S10) ------------------------------ */

    function test_fork_aTokenDonation_doesNotBreakBuyLoop() public {
        _scene(5e6);
        uint256 id = _openSession(80e6);
        uint256 cash = IERC20(USDC).balanceOf(A_USDC);
        uint256 v = POOL.getVirtualUnderlyingBalance(USDC);
        address donor = makeAddr("donor");
        deal(USDC, donor, 3);
        vm.prank(donor);
        IERC20(USDC).transfer(A_USDC, 3);
        assertEq(IERC20(USDC).balanceOf(A_USDC), cash + 3);
        assertEq(POOL.getVirtualUnderlyingBalance(USDC), v, "a donation does not raise Aave's virtual balance");
        assertEq(market.capacity().withdrawable, v);
        (uint256 aaveChunk,) = market.flashCapacity();
        assertEq(aaveChunk, v * 10_000 / (10_000 + POOL.FLASHLOAN_PREMIUM_TOTAL()) - 1);
        uint256 price = market.quote(50e6, market.discountOf(id), AUSD);
        _payAusd(price);
        vm.prank(buyer);
        (, uint256 repaid) = market.buyAndRepay(id, 50e6, PAY_AUSD, price, "");
        assertLt(repaid, 50e6);
        assertApproxEqRel(repaid, 50e6, 0.001e18);
        assertApproxEqAbs(POOL.getVirtualUnderlyingBalance(USDC), v, 1);
    }

    function test_fork_usdt0Feed_answerOnly() public {
        // The "USD Scaled" aggregator has no working latestRoundData.
        vm.expectRevert();
        IPriceFeed(USDT0_USD_FEED).latestRoundData();
        int256 answer = IAnswerAggregator(USDT0_USD_FEED).latestAnswer();
        assertGt(answer, 0);
        AnswerOnlyFeed feed = AnswerOnlyFeed(prices.feedOf(USDT0));
        assertEq(address(feed.aggregator()), USDT0_USD_FEED);
        assertEq(feed.decimals(), 8);
        assertEq(prices.priceOf(USDT0), uint256(answer), "USDT0 is priced at its market answer");
    }

    /* ------------------------------ Protocol fee (Part 0 §0.12) ------------------------------ */

    function test_fork_fee_collateralMode_splitsWithdrawnPayToken() public {
        _scene(5e6);
        uint256 id = _openSession(80e6);
        uint256 price = market.quote(40e6, market.discountOf(id), WETH);
        uint256 collateralBefore = IERC20(A_WETH).balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20(A_WETH).approve(address(market), price + market.collateralPullMargin(WETH));
        (uint256 paid,) = market.buyAndRepayWithCollateral(id, 40e6, PAY_WETH, price, "");
        vm.stopPrank();
        assertEq(paid, price, "the buyer pays the quote");
        assertApproxEqAbs(collateralBefore - IERC20(A_WETH).balanceOf(buyer), paid, 2, "the buyer pays the quote");
        uint256 fee = market.feeOf(paid);
        assertGt(fee, 0);
        assertEq(IERC20(WETH).balanceOf(seller), paid - fee, "the WETH withdrawn from Aave goes to the seller");
        assertEq(IERC20(WETH).balanceOf(treasury), fee, "and the fee to the fee recipient");
        assertEq(IERC20(WETH).balanceOf(address(market)), 0, "nothing stays in the market");
        assertEq(IERC20(A_WETH).balanceOf(address(market)), 0, "nothing stays in the market");
    }
}
