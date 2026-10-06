// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {KuruMath} from "../../src/kuru/KuruMath.sol";
import {KuruMarketParams} from "../../src/shared/interfaces/IKuru.sol";

/// @notice Unit and fuzz tests of the Kuru price, discount, size and debit conversions.
contract KuruMathTest is Test {
    uint256 internal constant BPS = 10_000;
    /// @dev waMonUSDT0 face value of one whole share at block 94,027,500.
    uint256 internal constant F = 1_002_164;

    /// @dev The usdt0-replay market (waMonUSDT0 / USDT0, both 6 decimals).
    function _replay() internal pure returns (KuruMarketParams memory) {
        return KuruMarketParams(1e6, 1e6, address(1), 6, address(2), 6, 100, 1e6, 1e15, 0, 0);
    }

    /// @dev A market whose price unit is coarser than the quote's wei (each price unit is 1,000 quote wei), with an
    /// 18-decimal base and a taker fee, so the debit's rounding has a visible step.
    function _coarse() internal pure returns (KuruMarketParams memory) {
        return KuruMarketParams(1e3, 1e4, address(1), 18, address(2), 6, 1, 1, 1e20, 30, 10);
    }

    function _params(bool coarse) internal pure returns (KuruMarketParams memory) {
        return coarse ? _coarse() : _replay();
    }

    /* ------------------------------ Worked examples ------------------------------ */

    function test_priceDiscount_workedExample() public pure {
        KuruMarketParams memory m = _replay();
        assertEq(KuruMath.parPrice(F, m), 1_002_164, "price at par");
        assertEq(KuruMath.priceForDiscount(300, F, m), 972_000, "972,099.08 floored to the tick");
        assertEq(KuruMath.discountOf(972_000, F, m), 300, "3.0098%, floored");
        assertEq(KuruMath.discountOf(1_002_164, F, m), 0);
        assertEq(KuruMath.discountOf(1_100_000, F, m), 0, "a premium reads as no discount");
        assertEq(KuruMath.vaultPrice(F, 300, m), 972_000, "no taker fee: the vault price is P(minDiscount)");
    }

    function test_vaultOrder_workedExample() public pure {
        KuruMarketParams memory m = _replay();
        uint256 price = KuruMath.vaultPrice(F, 300, m);
        // 10,000 USDT0 of room and budget.
        uint256 size = KuruMath.sizeFor(price, F, 10_000e6, 10_000e6, m);
        assertEq(size, 9_978_406_727, "the room bound binds: face 9,999.999999 USDT0");
        assertEq(KuruMath.debit(price, size, m), 9_699_011_339);
        assertEq(KuruMath.sizeFor(price, F, 10_000e6, type(uint128).max, m), 10_288_065_843, "escrow bound");
        assertEq(KuruMath.baseAmount(size, m), size, "6-decimal base at size precision 1e6");
    }

    function test_refundValue_matchesKuruCancel() public pure {
        // A bid of 1,000,000 at 960,000 debited 960,000; after fills of 996,757 its cancel refunded 3,113.
        KuruMarketParams memory m = _replay();
        assertEq(KuruMath.debit(960_000, 1e6, m), 960_000);
        assertEq(KuruMath.refundValue(3_243, 960_000, m), 3_113);
        assertEq(960_000 - KuruMath.refundValue(3_243, 960_000, m), 956_887, "cost of 996,757 base");
        // A bid of 2,000,000 at 970,000 debits and refunds 1,940,000 (fork probe).
        assertEq(KuruMath.debit(970_000, 2e6, m), 1_940_000);
        assertEq(KuruMath.refundValue(2e6, 970_000, m), 1_940_000);
    }

    function test_vaultPrice_netOfTakerFee() public pure {
        KuruMarketParams memory m = _replay();
        m.takerFeeBps = 30;
        // 1,002,164 × 0.97 × 0.997 = 969,182.78 → tick 969,100.
        assertEq(KuruMath.vaultPrice(F, 300, m), 969_100);
        assertGe(KuruMath.discountOf(969_100, F, m), 300);
    }

    function test_sizeFor_debitRoundingStep() public pure {
        // Each price unit is 1,000 quote wei, so the rounded-up debit moves in steps of 1,000: the size shrinks until
        // the debit fits the budget.
        KuruMarketParams memory m = _coarse();
        uint256 size = KuruMath.sizeFor(999, 1e6, 999_999, type(uint128).max, m);
        assertLe(KuruMath.debit(999, size, m), 999_999);
        assertGt(KuruMath.debit(999, size + 1, m), 999_999, "largest size that fits");
    }

    /* ------------------------------ Fuzz ------------------------------ */

    function testFuzz_priceForDiscount_neverAboveBound(uint256 face, uint256 d, bool coarse) public pure {
        KuruMarketParams memory m = _params(coarse);
        face = bound(face, 1, 1e30);
        d = bound(d, 0, BPS);
        uint256 price = KuruMath.priceForDiscount(d, face, m);
        assertLe(price * 10 ** m.quoteDecimals * BPS, face * m.pricePrecision * (BPS - d), "never pays above the bound");
        assertEq(price % m.tickSize, 0, "on a tick");
    }

    function testFuzz_discountOfPriceForDiscount_atLeastD(uint256 face, uint256 d, bool coarse) public pure {
        KuruMarketParams memory m = _params(coarse);
        face = bound(face, 1, 1e30);
        d = bound(d, 0, BPS - 1);
        uint256 price = KuruMath.priceForDiscount(d, face, m);
        vm.assume(price > 0);
        assertGe(KuruMath.discountOf(price, face, m), d);
    }

    function testFuzz_vaultPrice_meetsMinimumDiscountNetOfFee(uint256 face, uint256 d, uint256 fee) public pure {
        KuruMarketParams memory m = _replay();
        face = bound(face, 1e3, 1e30);
        d = bound(d, 0, 5_000);
        m.takerFeeBps = bound(fee, 0, 500);
        uint256 price = KuruMath.vaultPrice(face, d, m);
        assertLe(price * 10 ** m.quoteDecimals * BPS * BPS, face * m.pricePrecision * (BPS - d) * (BPS - m.takerFeeBps));
        if (price > 0) assertGe(KuruMath.discountOf(price, face, m), d);
    }

    function testFuzz_sizeFor_withinBudgetRoomAndMax(
        uint256 price,
        uint256 face,
        uint256 budget,
        uint256 room,
        bool coarse
    ) public pure {
        KuruMarketParams memory m = _params(coarse);
        price = bound(price, 1, type(uint32).max);
        face = bound(face, 1, 1e30);
        budget = bound(budget, 0, 1e30);
        room = bound(room, 0, 1e30);
        uint256 size = KuruMath.sizeFor(price, face, budget, room, m);
        assertLe(KuruMath.debit(price, size, m), budget, "debit within budget");
        // Face value of `size` is size × face / sizePrecision, compared exactly.
        assertLe(size * face, room * m.sizePrecision, "face value within room");
        assertLe(Math.mulDiv(size, face, m.sizePrecision), room);
        assertLe(size, m.maxSize, "at most maxSize");
        // Maximal: one more size unit breaks a bound.
        if (size < m.maxSize) {
            bool overBudget = KuruMath.debit(price, size + 1, m) > budget;
            bool overRoom = (size + 1) * face > room * m.sizePrecision;
            assertTrue(overBudget || overRoom, "largest size within both bounds");
        }
    }

    function testFuzz_refundNeverAboveDebit(uint256 price, uint256 size, uint256 rest, bool coarse) public pure {
        KuruMarketParams memory m = _params(coarse);
        price = bound(price, 1, type(uint32).max);
        size = bound(size, 1, type(uint96).max);
        rest = bound(rest, 0, size);
        assertLe(KuruMath.refundValue(rest, price, m), KuruMath.debit(price, size, m));
    }
}
