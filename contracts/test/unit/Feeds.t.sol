// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainedPriceFeed} from "../../src/shared/oracle/ChainedPriceFeed.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {AnswerOnlyFeed, IAnswerAggregator} from "../../src/shared/oracle/AnswerOnlyFeed.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {IPriceFeed} from "../../src/shared/interfaces/IPriceFeed.sol";
import {FixedMorphoOracle} from "../../src/testnet/FixedMorphoOracle.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {MockPriceFeed} from "../utils/MockPriceFeed.sol";
import {MockAnswerAggregator} from "../utils/MockAnswerAggregator.sol";

contract FeedsTest is Test {
    function setUp() public {
        vm.warp(1_780_000_000);
    }

    function test_chained_wstEthUsd() public {
        ChainedPriceFeed feed =
            new ChainedPriceFeed(new MockPriceFeed(1.2318e18, 18), new MockPriceFeed(2_353.89e8, 8));
        assertEq(feed.decimals(), 8);
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(answer, 2_899_521_702_00, "1.2318 * 2353.89 = 2899.521702");
        assertEq(updatedAt, block.timestamp);
    }

    function test_chained_reportsOlderUpdate() public {
        MockPriceFeed base = new MockPriceFeed(1e18, 18);
        MockPriceFeed quote = new MockPriceFeed(1e8, 8);
        base.setUpdatedAt(block.timestamp - 5 hours);
        (,,, uint256 updatedAt,) = new ChainedPriceFeed(base, quote).latestRoundData();
        assertEq(updatedAt, block.timestamp - 5 hours);
    }

    function test_chained_nonPositiveLegGivesZero() public {
        MockPriceFeed base = new MockPriceFeed(0, 18);
        (, int256 answer,,,) = new ChainedPriceFeed(base, new MockPriceFeed(1e8, 8)).latestRoundData();
        assertEq(answer, 0);
    }

    function test_fixedFeed_rejectsZero() public {
        vm.expectRevert(bytes("price"));
        new FixedPriceFeed(0, 8);
    }

    function test_fixedMorphoOracle() public {
        assertEq(new FixedMorphoOracle(1e24).price(), 1e24);
        vm.expectRevert(bytes("price"));
        new FixedMorphoOracle(0);
    }

    function test_testToken_mintLimit() public {
        TestToken token = new TestToken("Simulated AUSD", "AUSD-sim", 18, 1_000 ether);
        assertEq(token.decimals(), 18);
        token.mint(address(this), 1_000 ether);
        assertEq(token.balanceOf(address(this)), 1_000 ether);
        vm.expectRevert(TestToken.MintLimit.selector);
        token.mint(address(this), 1_000 ether + 1);
    }

    function test_answerOnlyFeed_readsLatestAnswer() public {
        MockAnswerAggregator agg = new MockAnswerAggregator(99_887_000, 8);
        AnswerOnlyFeed feed = new AnswerOnlyFeed(IAnswerAggregator(address(agg)));
        assertEq(feed.decimals(), 8);
        assertEq(address(feed.aggregator()), address(agg));
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        assertEq(roundId, 1);
        assertEq(answer, 99_887_000);
        assertEq(startedAt, block.timestamp);
        assertEq(updatedAt, block.timestamp);
        assertEq(answeredInRound, 1);

        // The aggregator has no update time, so the feed always reports the current block.
        vm.warp(block.timestamp + 3 days);
        (,,, updatedAt,) = feed.latestRoundData();
        assertEq(updatedAt, block.timestamp);

        address t = makeAddr("t");
        address[] memory tokens = new address[](1);
        tokens[0] = t;
        address[] memory feeds = new address[](1);
        feeds[0] = address(feed);
        uint256[] memory ages = new uint256[](1);
        ages[0] = 1 days;
        PriceRouter r = new PriceRouter(tokens, feeds, ages);
        assertEq(r.priceOf(t), 99_887_000);

        agg.set(0);
        vm.expectRevert(abi.encodeWithSelector(PriceRouter.BadPrice.selector, t));
        r.priceOf(t);
    }
}
