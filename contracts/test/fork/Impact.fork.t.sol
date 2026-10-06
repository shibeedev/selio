// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveForkBase} from "./AaveForkBase.t.sol";

/// @notice What a purchase changes on the live Aave pool, and what it must leave alone.
contract ImpactForkTest is AaveForkBase {
    address internal bystander = makeAddr("bystander");
    address internal otherSeller = makeAddr("otherSeller");
    address internal otherBorrower = makeAddr("otherBorrower");

    function _openFor(address who, uint256 amount) internal returns (uint256 id) {
        vm.startPrank(who);
        IERC20(A_USDC).approve(address(market), amount);
        id = market.openSession(amount, _params());
        vm.stopPrank();
    }

    function _ausdBid(uint16 minD, uint256 maxAssets) internal returns (uint256 bidId, uint256 escrow) {
        escrow = market.quote(maxAssets, minD, AUSD);
        _dealAusd(bidder, escrow);
        vm.startPrank(bidder);
        IERC20(AUSD).approve(address(market), escrow);
        bidId = market.placeBid(minD, PAY_AUSD, maxAssets, escrow);
        vm.stopPrank();
    }

    struct Snapshot {
        uint256 liquidity;
        uint256 supplied;
        uint256 debt;
        uint256 bystanderBalance;
        uint256 otherDebt;
        uint256 otherRemaining;
        uint256 otherHf;
        uint256 escrowTotal;
    }

    function test_fork_buyOnlyMovesTheTradedAmount() public {
        _supplyUsdc(bystander, 25e6);
        _supplyUsdc(otherSeller, 30e6);
        _supplyWeth(otherBorrower, _wethFor(100));
        _borrow(otherBorrower, USDC, 20e6);
        _scene(3e6);
        uint256 sessionId = _openSession(60e6);
        // Aave's rounding can leave the 30 USDC supplied a wei short of 30e6 aMonUSDC.
        uint256 otherSession = _openFor(otherSeller, IERC20(A_USDC).balanceOf(otherSeller));
        (uint256 bidId, uint256 escrow) = _ausdBid(500, 5e6);

        Snapshot memory b;
        b.liquidity = _usdcLiquidity();
        b.supplied = IERC20(A_USDC).totalSupply();
        b.debt = IERC20(V_USDC).totalSupply();
        b.bystanderBalance = IERC20(A_USDC).balanceOf(bystander);
        b.otherDebt = _debt(otherBorrower);
        b.otherRemaining = market.remainingAssets(otherSession);
        b.otherHf = _hf(otherBorrower);
        b.escrowTotal = market.totalEscrow(AUSD);

        uint256 price = market.quote(40e6, market.discountOf(sessionId), AUSD);
        _dealAusd(buyer, price);
        vm.startPrank(buyer);
        IERC20(AUSD).approve(address(market), price);
        (, uint256 repaid) = market.buyAndRepay(sessionId, 40e6, PAY_AUSD, price, "");
        vm.stopPrank();

        assertApproxEqAbs(_usdcLiquidity(), b.liquidity, 1);
        assertApproxEqRel(b.supplied - IERC20(A_USDC).totalSupply(), 40e6, 0.0001e18);
        assertApproxEqAbs(b.debt - IERC20(V_USDC).totalSupply(), repaid, 200);
        // Balances only grow, from interest and flash premium to suppliers, never shrink.
        assertGe(IERC20(A_USDC).balanceOf(bystander), b.bystanderBalance);
        assertGe(_debt(otherBorrower), b.otherDebt);
        assertLe(_hf(otherBorrower), b.otherHf, "unaffected beyond interest");
        assertGe(market.remainingAssets(otherSession), b.otherRemaining);
        assertEq(market.totalEscrow(AUSD), b.escrowTotal);
        (address bidBidder,,,, uint256 bidEscrow) = market.bids(bidId);
        assertEq(bidBidder, bidder, "bid still live");
        assertEq(bidEscrow, escrow, "bid escrow intact");
        assertGe(
            IERC20(A_USDC).balanceOf(address(market)) + 2,
            market.remainingAssets(sessionId) + market.remainingAssets(otherSession)
        );
    }

    function test_fork_sellNowLeavesThePoolAlone() public {
        _scene(3e6);
        (uint256 bidId,) = _ausdBid(400, 10e6);
        uint256 liquidity = _usdcLiquidity();
        uint256 supplied = IERC20(A_USDC).totalSupply();
        uint256 debt = IERC20(V_USDC).totalSupply();
        vm.startPrank(seller);
        IERC20(A_USDC).approve(address(market), 10e6);
        market.sellNow(10e6, _ids(bidId), 400, 0x01, 10e6);
        vm.stopPrank();
        // A sale into a bid only moves receipts between holders.
        assertEq(_usdcLiquidity(), liquidity);
        assertEq(IERC20(A_USDC).totalSupply(), supplied);
        assertEq(IERC20(V_USDC).totalSupply(), debt);
    }
}
