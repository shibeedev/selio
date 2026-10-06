// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {MockPriceFeed} from "../utils/MockPriceFeed.sol";

contract PriceRouterTest is Test {
    address internal tokenA = makeAddr("A");
    address internal tokenB = makeAddr("B");
    address internal tokenC = makeAddr("C");
    MockPriceFeed internal feedA;
    MockPriceFeed internal feedB;
    PriceRouter internal router;

    function setUp() public {
        vm.warp(1_780_000_000);
        feedA = new MockPriceFeed(2_500e8, 8);
        feedB = new MockPriceFeed(1e18, 18);
        FixedPriceFeed fixedFeed = new FixedPriceFeed(99_990_000, 8);
        address[] memory tokens = new address[](3);
        (tokens[0], tokens[1], tokens[2]) = (tokenA, tokenB, tokenC);
        address[] memory feeds = new address[](3);
        (feeds[0], feeds[1], feeds[2]) = (address(feedA), address(feedB), address(fixedFeed));
        uint256[] memory ages = new uint256[](3);
        (ages[0], ages[1], ages[2]) = (1 days, 1 days, 1 days);
        router = new PriceRouter(tokens, feeds, ages);
    }

    function test_normalisesTo8Decimals() public view {
        assertEq(router.priceOf(tokenA), 2_500e8);
        assertEq(router.priceOf(tokenB), 1e8);
        assertEq(router.priceOf(tokenC), 99_990_000);
    }

    function test_revertsOnMissingFeed() public {
        vm.expectRevert(abi.encodeWithSelector(PriceRouter.FeedMissing.selector, address(1)));
        router.priceOf(address(1));
    }

    function test_revertsOnStalePrice() public {
        feedA.setUpdatedAt(block.timestamp - 1 days - 1);
        vm.expectRevert();
        router.priceOf(tokenA);
    }

    function test_revertsOnNonPositivePrice() public {
        feedA.set(0);
        vm.expectRevert(abi.encodeWithSelector(PriceRouter.BadPrice.selector, tokenA));
        router.priceOf(tokenA);
    }

    function test_constructorRejectsLengthMismatch() public {
        vm.expectRevert(PriceRouter.LengthMismatch.selector);
        new PriceRouter(new address[](1), new address[](0), new uint256[](1));
        vm.expectRevert(PriceRouter.LengthMismatch.selector);
        new PriceRouter(new address[](1), new address[](1), new uint256[](0));
    }

    function test_perFeedMaxAge() public {
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (tokenA, tokenB);
        address[] memory feeds = new address[](2);
        (feeds[0], feeds[1]) = (address(feedA), address(feedB));
        uint256[] memory ages = new uint256[](2);
        (ages[0], ages[1]) = (1 hours, 1 days);
        PriceRouter r = new PriceRouter(tokens, feeds, ages);
        feedA.setUpdatedAt(block.timestamp - 1 hours - 1);
        feedB.setUpdatedAt(block.timestamp - 1 hours - 1);
        assertEq(r.maxAgeOf(tokenA), 1 hours);
        assertEq(r.maxAgeOf(tokenB), 1 days);
        vm.expectRevert(abi.encodeWithSelector(PriceRouter.StalePrice.selector, tokenA, block.timestamp - 1 hours - 1));
        r.priceOf(tokenA);
        assertEq(r.priceOf(tokenB), 1e8, "the same age passes under its own, longer bound");
    }
}
