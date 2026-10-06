// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {MockPriceFeed} from "../utils/MockPriceFeed.sol";

/// @notice Pricing properties with a volatile payment token (sim-AUSD priced away from $1).
contract PricingTest is MorphoBase {
    MockPriceFeed internal ausdFeed;

    function setUp() public override {
        super.setUp();
        ausdFeed = new MockPriceFeed(1.17e8, 8);
        prices = new PriceRouter(
            _pair(address(usdc), address(ausd)),
            _pair(address(new MockPriceFeed(0.9998e8, 8)), address(ausdFeed)),
            _uintPair(1 days, 1 days)
        );
        market = _newMarket(prices, _pair(address(usdc), address(ausd)));
    }

    function testFuzz_quote_neverUndercharges(uint96 assets, uint16 d, uint64 px) public {
        uint256 a = bound(assets, 1, 1e15 * USD);
        uint16 disc = uint16(bound(d, 0, 5000));
        ausdFeed.set(int256(bound(px, 1e6, 1e12)));
        uint256 q = market.quote(a, disc, address(ausd));
        assertGe(market.assetsFor(q, disc, address(ausd)), a, "paying the quote buys at least assets");
    }

    function testFuzz_assetsFor_neverOverspendsEscrow(uint96 escrow, uint16 d, uint64 px) public {
        uint256 e = bound(escrow, 1, 1e27);
        uint16 disc = uint16(bound(d, 0, 5000));
        ausdFeed.set(int256(bound(px, 1e6, 1e12)));
        uint256 a = market.assetsFor(e, disc, address(ausd));
        if (a == 0) return;
        // bid capacity is fully funded, within one unit of rounding in the pay token
        assertLe(market.quote(a, disc, address(ausd)), e + 1);
    }

    function testFuzz_higherDiscount_cheaper(uint96 assets, uint16 d1, uint16 d2) public view {
        uint256 a = bound(assets, 1, 1e15 * USD);
        uint16 lo = uint16(bound(d1, 0, 5000));
        uint16 hi = uint16(bound(d2, lo, 5000));
        assertLe(market.quote(a, hi, address(usdc)), market.quote(a, lo, address(usdc)));
        assertLe(market.quote(a, hi, address(ausd)), market.quote(a, lo, address(ausd)));
    }

    function test_quote_sameAssetIgnoresOracle() public view {
        assertEq(market.quote(1_000 * USD, 250, address(usdc)), 975e6);
    }

    function test_quote_crossAsset() public view {
        // 1,000 USDC face at 2.5% = 975 USDC worth; USDC $0.9998, AUSD $1.17
        uint256 expected = uint256(975 * 1e18) * 0.9998e8 / 1.17e8;
        assertApproxEqAbs(market.quote(1_000 * USD, 250, address(ausd)), expected, 1);
    }

    function test_constructor_requiresFeeds() public {
        address[] memory tokens = _pair(address(usdc), makeAddr("noFeed"));
        vm.expectRevert(ExitMarket.BadParams.selector);
        _newMarket(prices, tokens);
    }

    function test_constructor_rejectsDuplicatePayTokens() public {
        vm.expectRevert(ExitMarket.BadParams.selector);
        _newMarket(prices, _pair(address(usdc), address(usdc)));
    }
}
