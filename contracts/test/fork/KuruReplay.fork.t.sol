// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {KuruDeployHarness} from "../utils/KuruDeployHarness.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {AaveExitMarket} from "../../src/venues/aave/AaveExitMarket.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {KuruSellRouter} from "../../src/kuru/KuruSellRouter.sol";
import {KuruMath} from "../../src/kuru/KuruMath.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {AnswerOnlyFeed, IAnswerAggregator} from "../../src/shared/oracle/AnswerOnlyFeed.sol";
import {IAavePool} from "../../src/shared/interfaces/IAaveV3.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";
import {IKuruOrderBook, IKuruMarginAccount, IKuruRouter, KuruMarketParams} from "../../src/shared/interfaces/IKuru.sol";
import {IStataToken} from "../../src/shared/interfaces/IStataToken.sol";

/// @dev Kuru functions only the tests call: admin pauses and resting asks.
interface IKuruTestOnly {
    function toggleMarkets(address[] calldata markets, uint8 state) external;
    function toggleProtocolState(bool state) external;
    function addSellOrder(uint32 price, uint96 size, bool postOnly) external;
}

/// @notice Kuru on a fork of Monad mainnet at block 94,027,500, when Aave's USDT0 reserve had 0 withdrawable: the
/// waMonUSDT0/USDT0 market created with Selio's parameters, the Selio Vault's Kuru leg and the routed sale.
/// @dev Runs with the other Monad mainnet fork suites (`MONAD_RPC` set) and forks the historical block through
/// `MONAD_ARCHIVE_RPC` (default https://rpc2.monad.xyz).
contract KuruReplayForkTest is Test {
    uint256 internal constant REPLAY_BLOCK = 94_027_500;
    /// @dev waMonUSDT0 face value of one share at the replay block.
    uint256 internal constant F = 1_002_164;

    IAavePool internal constant POOL = IAavePool(0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef);
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant WETH = 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242;
    address internal constant A_AUSD = 0xdeBFeDF35faEd5d1664E553545e144C02227A2Ec;
    address internal constant A_USDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    address internal constant A_USDT0 = 0x9531E6bC99D7F7f0596ed7bA5b846Ba9Eb60468c;
    address internal constant A_WETH = 0x4377b53aAA8b8e3fF7AA2843832CAF004f5Cb8b6;
    address internal constant USDT0_DEBT = 0x85812C8eEeB8723e3C60d0Dc78e697b4E7e5a35D;
    address internal constant MORPHO = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
    address internal constant AUSD_USD_FEED = 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13;
    address internal constant USDC_USD_FEED = 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec;
    address internal constant ETH_USD_FEED = 0x1B1414782B859871781bA3E4B0979b9ca57A0A04;
    address internal constant USDT0_USD_AGGREGATOR = 0x109959f1Aa3d05dF1F4eA965d6eAE5c1c8358885;
    address internal constant WA_MON_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2;
    IStataToken internal constant WA = IStataToken(0x5E7109A755fD2b86361F95065cDE07FbAb50CA1D);
    IKuruRouter internal constant KURU_ROUTER = IKuruRouter(0xd651346d7c789536ebf06dc72aE3C8502cd695CC);
    IKuruMarginAccount internal constant MA = IKuruMarginAccount(0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5);
    /// @dev Owner of Kuru's Router (market pauses) and MarginAccount (protocol pause) on Monad.
    address internal constant KURU_OWNER = 0x8B736DCe2071783Fd9DB0a423dad17cc8ed5788b;
    /// @dev An account holding 62.9M aMonUSDT0 at the replay block: receipts without adding pool cash.
    address internal constant A_USDT0_HOLDER = 0x1be45feF92C4E2538fEcd150757Ed62b7B3757D7;
    uint8 internal constant PAY_USDT0 = 2;
    bytes4 internal constant MARKET_STATE_ERROR = 0x004b65ba;
    bytes4 internal constant SLIPPAGE_EXCEEDED = 0x8199f5f3;

    AaveExitMarket internal market;
    KuruDeployHarness internal harness;
    IKuruOrderBook internal book;
    KuruSellRouter internal router;
    SelioVault internal ev;
    address internal treasury = makeAddr("treasury");
    address internal depositor = makeAddr("depositor");
    address internal other = makeAddr("other");
    address internal seller = makeAddr("seller");
    address internal bidder = makeAddr("bidder");
    address internal gifter = makeAddr("gifter");

    function setUp() public {
        if (bytes(vm.envOr("MONAD_RPC", string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("MONAD_ARCHIVE_RPC", string("https://rpc2.monad.xyz")), REPLAY_BLOCK);
        address[] memory tokens = _addresses(AUSD, USDC, USDT0, WETH);
        address usdt0Feed = address(new AnswerOnlyFeed(IAnswerAggregator(USDT0_USD_AGGREGATOR)));
        uint256[] memory ages = new uint256[](4);
        (ages[0], ages[1], ages[2], ages[3]) = (2 days, 2 days, 2 days, 2 days);
        PriceRouter prices =
            new PriceRouter(tokens, _addresses(AUSD_USD_FEED, USDC_USD_FEED, usdt0Feed, ETH_USD_FEED), ages);
        uint256[] memory minEscrows = new uint256[](4);
        (minEscrows[0], minEscrows[1], minEscrows[2], minEscrows[3]) = (1, 1, 1, 1);
        market = new AaveExitMarket(
            POOL,
            A_USDT0,
            USDT0_DEBT,
            prices,
            tokens,
            _addresses(A_AUSD, A_USDC, address(0), A_WETH),
            IMorpho(MORPHO),
            minEscrows,
            treasury
        );
        harness = new KuruDeployHarness();
        book = harness.kuruMarket(KURU_ROUTER, address(WA), USDT0);
        router = new KuruSellRouter(market, book, WA);
        ev = _vault(300);
    }

    /* ------------------------------ Helpers ------------------------------ */

    function _addresses(address a, address b, address c, address d) internal pure returns (address[] memory r) {
        r = new address[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    /// @dev A USDT0 Selio Vault on `market` with a 20% cap and the waMonUSDT0 Kuru leg at half the room.
    function _vault(uint16 minDiscountBps) internal returns (SelioVault) {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = minDiscountBps;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        SelioVault.KuruLeg[] memory legs = new SelioVault.KuruLeg[](1);
        legs[0] = SelioVault.KuruLeg(book, MA, WA);
        return new SelioVault(
            "Selio Vault USDT0",
            "slUSDT0",
            IERC20(USDT0),
            markets,
            minD,
            maxShare,
            IERC4626(address(0)),
            ISourceProbe(address(0)),
            legs,
            5_000
        );
    }

    function _params() internal view returns (KuruMarketParams memory) {
        return book.getMarketParams();
    }

    function _deposit(SelioVault v, address who, uint256 amount) internal returns (uint256 shares) {
        _fund(v, who, amount);
        vm.prank(who);
        shares = v.deposit(amount, who, 0);
    }

    function _fund(SelioVault v, address who, uint256 amount) internal {
        deal(USDT0, who, amount);
        vm.prank(who);
        IERC20(USDT0).approve(address(v), amount);
    }

    /// @dev aMonUSDT0 from a holder, so the frozen reserve keeps 0 withdrawable.
    function _aTokens(address to, uint256 amount) internal {
        vm.prank(A_USDT0_HOLDER);
        IERC20(A_USDT0).transfer(to, amount);
    }

    function _wrapped(address to, uint256 aTokens) internal returns (uint256 shares) {
        _aTokens(to, aTokens);
        vm.startPrank(to);
        IERC20(A_USDT0).approve(address(WA), aTokens);
        shares = WA.depositATokens(aTokens, to);
        vm.stopPrank();
    }

    /// @dev aMonUSDT0 that wrap into at least `shares` waMonUSDT0 (`F` is rounded down, so it undercounts).
    function _aTokensFor(uint256 shares) internal view returns (uint256) {
        return IERC4626(address(WA)).previewMint(shares) + 2;
    }

    /// @dev `who` market-sells `size` waMonUSDT0 (6 decimals: one size unit is one share wei) on the book.
    function _marketSell(address who, uint256 size) internal returns (uint256 out) {
        _wrapped(who, _aTokensFor(size));
        vm.startPrank(who);
        IERC20(address(WA)).approve(address(book), size);
        out = book.placeAndExecuteMarketSell(uint96(size), 0, false, false);
        vm.stopPrank();
    }

    /// @dev A post-only Kuru limit bid of `who`.
    function _kuruBid(address who, uint32 price, uint96 size) internal {
        uint256 d = KuruMath.debit(price, size, _params());
        deal(USDT0, who, d);
        vm.startPrank(who);
        IERC20(USDT0).approve(address(MA), d);
        MA.deposit(who, USDT0, d);
        book.addBuyOrder(price, size, true);
        vm.stopPrank();
    }

    /// @dev A post-only Kuru ask of `who` for `size` waMonUSDT0 at `price`.
    function _kuruAsk(address who, uint32 price, uint96 size) internal {
        uint256 shares = _wrapped(who, _aTokensFor(size));
        vm.startPrank(who);
        IERC20(address(WA)).approve(address(MA), shares);
        MA.deposit(who, address(WA), shares);
        IKuruTestOnly(address(book)).addSellOrder(price, size, true);
        vm.stopPrank();
    }

    function _setMarketState(uint8 state) internal {
        address[] memory markets = new address[](1);
        markets[0] = address(book);
        vm.prank(KURU_OWNER);
        IKuruTestOnly(address(KURU_ROUTER)).toggleMarkets(markets, state);
    }

    function _leg(SelioVault v)
        internal
        view
        returns (uint40 orderId, uint32 price, uint96 placedSize, uint256 escrow, uint256 baseAtPlace)
    {
        (,,, orderId, price, placedSize, escrow, baseAtPlace) = v.kuruLeg(0);
    }

    function _selioBid(SelioVault v) internal view returns (uint256 maxAssets, uint256 escrow) {
        (,,, maxAssets, escrow) = market.bids(v.bidOf(0));
    }

    function _cap(SelioVault v) internal view returns (uint256) {
        return v.totalAssets() * 2_000 / 10_000;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    /* ------------------------------ Market creation ------------------------------ */

    function test_fork_kuru_marketCreatedWithSelioParams_andReused() public {
        KuruMarketParams memory p = _params();
        assertEq(p.pricePrecision, 1e6);
        assertEq(p.sizePrecision, 1e6);
        assertEq(p.base, address(WA));
        assertEq(p.baseDecimals, 6);
        assertEq(p.quote, USDT0);
        assertEq(p.quoteDecimals, 6);
        assertEq(p.tickSize, 100);
        assertEq(p.minSize, 1e6);
        assertEq(p.maxSize, 1e15);
        assertEq(p.takerFeeBps, 0);
        assertEq(p.makerFeeBps, 0);
        assertEq(book.marketState(), 0, "active");
        assertEq(KURU_ROUTER.verifiedMarket(address(book)).base, address(WA), "registered with the Router");
        // A second run reuses the market: same address, no second creation.
        assertEq(address(harness.kuruMarket(KURU_ROUTER, address(WA), USDT0)), address(book));
        // Creating it again directly is impossible: the CREATE2 address depends only on the parameters.
        vm.expectRevert();
        KURU_ROUTER.deployProxy(0, address(WA), USDT0, 1e6, 1e6, 100, 1e6, 1e15, 0, 0, 30);
    }

    function test_fork_kuru_wrapAndUnwrap_atFullUtilization() public {
        assertEq(POOL.getVirtualUnderlyingBalance(USDT0), 0, "USDT0 reserve frozen at the replay block");
        _aTokens(seller, 2e6);
        vm.startPrank(seller);
        IERC20(A_USDT0).approve(address(WA), 1.5e6);
        uint256 shares = WA.depositATokens(1.5e6, seller);
        assertApproxEqAbs(shares, WA.convertToShares(1.5e6), 1);
        assertApproxEqAbs(IERC20(A_USDT0).balanceOf(seller), 0.5e6, 1, "1.5 aMonUSDT0 wrapped");
        uint256 back = WA.redeemATokens(shares, seller, seller);
        vm.stopPrank();
        assertApproxEqAbs(back, 1.5e6, 2, "unwrapped to aMonUSDT0");
        assertEq(IERC20(address(WA)).balanceOf(seller), 0);
        assertEq(POOL.getVirtualUnderlyingBalance(USDT0), 0, "no pool cash used in either direction");
    }

    /* ------------------------------ Vault order ------------------------------ */

    function test_fork_kuru_vaultPlacesCompliantOrder() public {
        _deposit(ev, depositor, 100_000e6);
        (uint40 orderId, uint32 price, uint96 placedSize, uint256 escrow, uint256 baseAtPlace) = _leg(ev);
        KuruMarketParams memory p = _params();
        uint256 face = WA.convertToAssets(1e6);
        assertEq(face, F);
        assertGt(orderId, 0, "the order rests");
        assertEq(price % p.tickSize, 0);
        assertEq(price, 972_000);
        assertGe(KuruMath.discountOf(price, face, p), 300, "at least the minimum discount below face");
        // 20% of 100,000 USDT0 is the room; half of it, 10,000 USDT0, is quoted on Kuru.
        assertEq(placedSize, 9_978_406_727);
        assertEq(escrow, 9_699_011_339);
        assertEq(baseAtPlace, 0);
        (uint256 maxAssets, uint256 selioEscrow) = _selioBid(ev);
        assertLe(escrow + selioEscrow, 20_000e6, "Kuru debit plus Selio escrow within the room");
        assertEq(maxAssets, 20_000e6 - escrow);
        assertEq(selioEscrow, 20_000e6 - escrow);
        (uint256 bestBid,) = book.bestBidAsk();
        assertEq(bestBid, uint256(price) * 1e12, "the vault's bid tops the book (1e18 scale)");
        (bool active, uint96 rest, uint256 refund, uint256 pending) = ev.kuruOrderState(0);
        assertTrue(active);
        assertEq(rest, placedSize);
        assertEq(refund, KuruMath.refundValue(placedSize, price, p));
        assertEq(pending, escrow - refund, "Kuru's rounding wei");
        assertEq(ev.totalAssets(), 100_000e6, "share price unchanged by the placement");
        assertEq(MA.getBalance(address(ev), USDT0), 0, "nothing left idle in the margin account");
    }

    function test_fork_kuru_fillThenSync_booksCostAndUnits() public {
        // A 4.2% vault on 10.02164 USDT0: its Kuru bid is 1,000,000 at 960,000, debiting 960,000.
        SelioVault v = _vault(420);
        _deposit(v, depositor, 10_021_640);
        (, uint32 price, uint96 placedSize, uint256 escrow,) = _leg(v);
        assertEq(price, 960_000);
        assertEq(placedSize, 1e6);
        assertEq(escrow, 960_000);
        uint256 ta = v.totalAssets();
        uint256 out = _marketSell(seller, 996_757);
        assertEq(out, 956_886, "the seller is paid at 960,000, Kuru taker fee 0");
        (bool active, uint96 rest, uint256 refund, uint256 pending) = v.kuruOrderState(0);
        assertTrue(active);
        assertEq(rest, 3_243);
        assertEq(refund, 3_113);
        assertEq(pending, 956_887);
        assertEq(v.totalAssets(), ta, "the fill counts at cost from the moment it happens");
        assertLe(v.heldCost(0), _cap(v));

        uint256 aBefore = IERC20(A_USDT0).balanceOf(address(v));
        vm.recordLogs();
        v.refreshBids();
        (uint256 units, uint256 paid) = v.kuruFills(0);
        assertEq(paid, 956_887, "escrow minus refund");
        assertGt(units, 0);
        assertEq(v.heldUnits(0), units);
        _assertSynced(vm.getRecordedLogs(), units, 956_887, 3_113, 0);
        // Kuru fills are unwrapped: the vault holds aMonUSDT0, not waMonUSDT0.
        assertApproxEqAbs(IERC20(A_USDT0).balanceOf(address(v)) - aBefore, 996_757 * F / 1e6, 2);
        assertEq(IERC20(address(WA)).balanceOf(address(v)), 0);
        assertEq(MA.getBalance(address(v), address(WA)), 0);
        assertEq(MA.getBalance(address(v), USDT0), 0);
        assertLe(v.heldCost(0), _cap(v));
        assertApproxEqAbs(v.totalAssets(), ta, 2, "booking the fill moves no value");
    }

    function _assertSynced(Vm.Log[] memory logs, uint256 units, uint256 paid, uint256 refund, uint256 untracked)
        internal
        pure
    {
        bytes32 topic = keccak256("KuruSynced(uint256,uint256,uint256,uint256,uint256)");
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].topics[0] != topic) continue;
            (uint256 u, uint256 p, uint256 r, uint256 x) = abi.decode(logs[k].data, (uint256, uint256, uint256, uint256));
            assertEq(u, units, "synced units");
            assertEq(p, paid, "synced paid");
            assertEq(r, refund, "synced refund");
            assertEq(x, untracked, "synced untracked base");
            return;
        }
        revert("no KuruSynced");
    }

    function test_fork_kuru_baseGift_untracked() public {
        _deposit(ev, depositor, 1_000e6);
        uint256 ta = ev.totalAssets();
        uint256 shares = _wrapped(gifter, 5e6);
        vm.startPrank(gifter);
        IERC20(address(WA)).approve(address(MA), shares);
        MA.deposit(address(ev), address(WA), shares);
        vm.stopPrank();
        assertEq(ev.totalAssets(), ta, "a base gift is not valued");
        (uint40 orderId, uint32 price, uint96 placedSize, uint256 escrow,) = _leg(ev);
        uint256 refund = KuruMath.refundValue(placedSize, price, _params());
        assertGt(orderId, 0);
        vm.recordLogs();
        ev.refreshBids();
        _assertSynced(vm.getRecordedLogs(), 0, escrow - refund, refund, shares);
        assertEq(ev.heldUnits(0), 0, "untracked: never on the books");
        assertApproxEqAbs(IERC20(A_USDT0).balanceOf(address(ev)), 5e6, 2, "unwrapped and kept in kind");
        assertEq(ev.totalAssets(), ta, "still not valued");
        // A redemption shares the gift in kind, like receipts sent to the vault directly.
        uint256 all = ev.balanceOf(depositor);
        vm.prank(depositor);
        (, uint256[] memory receipts,) = ev.redeem(all, depositor, depositor, new uint256[](0));
        assertGt(receipts[0], 4.99e6);
    }

    function test_fork_kuru_quoteGift_becomesIdle() public {
        _deposit(ev, depositor, 1_000e6);
        uint256 ta = ev.totalAssets();
        uint256 idle = ev.idleAssets();
        deal(USDT0, gifter, 7e6);
        vm.startPrank(gifter);
        IERC20(USDT0).approve(address(MA), 7e6);
        MA.deposit(address(ev), USDT0, 7e6);
        vm.stopPrank();
        assertEq(ev.idleAssets(), idle + 7e6, "quote in the vault's margin account is idle cash");
        assertEq(ev.totalAssets(), ta + 7e6);
        ev.refreshBids();
        assertEq(MA.getBalance(address(ev), USDT0), 0, "withdrawn at sync");
        assertApproxEqAbs(ev.totalAssets(), ta + 7e6, 1);
    }

    function test_fork_kuru_crossingAskAtPlacement_doesNotRevert() public {
        // An ask at 950,000 rests below the vault's 972,000: the vault's order crosses it and buys at the ask.
        _kuruAsk(seller, 950_000, 2e6);
        _deposit(ev, depositor, 1_000e6);
        (uint40 orderId, uint32 price, uint96 placedSize, uint256 escrow, uint256 baseAtPlace) = _leg(ev);
        assertEq(price, 972_000);
        assertEq(baseAtPlace, 2e6, "bought the whole ask at once");
        assertGt(orderId, 0, "the rest of the order rests");
        uint256 restingValue = KuruMath.refundValue(placedSize, price, _params());
        assertApproxEqAbs(escrow, restingValue + 1_900_000, 2, "escrow = ask paid at 0.95 + resting order");
        (,,, uint256 pending) = ev.kuruOrderState(0);
        assertApproxEqAbs(pending, 1_900_000, 2, "the crossing buy counts at cost before the sync");
        ev.refreshBids();
        (uint256 units, uint256 paid) = ev.kuruFills(0);
        assertApproxEqAbs(paid, 1_900_000, 2);
        assertGt(units, 0);
        // Bought 2 shares (face 2.004328) for 1.9 USDT0: a deeper discount than the minimum, which the rules allow.
        assertGe(KuruMath.discountOf(950_000, F, _params()), 300);
    }

    function test_fork_kuru_orderFilledInFullAtPlacement_bookedAtNextSync() public {
        _kuruAsk(seller, 950_000, 150e6);
        _deposit(ev, depositor, 1_000e6);
        (uint40 orderId,, uint96 placedSize, uint256 escrow, uint256 baseAtPlace) = _leg(ev);
        assertEq(orderId, 0, "no order rests");
        assertEq(placedSize, 0);
        assertGt(baseAtPlace, 0);
        assertApproxEqAbs(escrow, baseAtPlace * 950_000 / 1e6, 2);
        ev.refreshBids();
        (uint256 units, uint256 paid) = ev.kuruFills(0);
        assertEq(paid, escrow, "booked at the escrow it spent");
        assertGt(units, 0);
        // The new order crossed the rest of the ask at once: only that base is in the margin account now.
        (,,,, uint256 baseAtPlace2) = _leg(ev);
        assertGt(baseAtPlace2, 0);
        assertEq(MA.getBalance(address(ev), address(WA)), baseAtPlace2);
        assertLe(ev.heldCost(0), _cap(ev));
    }

    function test_fork_kuru_capHoldsAfterFillsOnBothVenues() public {
        _deposit(ev, depositor, 1_000e6);
        uint256 cap = _cap(ev);
        uint256 ta = ev.totalAssets();
        // The Selio bid fills in full through sellNow...
        (uint256 maxAssets,) = _selioBid(ev);
        _aTokens(seller, 300e6);
        vm.startPrank(seller);
        IERC20(A_USDT0).approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(300e6, _ids(ev.bidOf(0)), 5_000, uint8(1 << PAY_USDT0), 0);
        vm.stopPrank();
        assertEq(filled, maxAssets, "clipped at the bid's room");
        // ...and the Kuru order fills in full on the book.
        (,, uint96 placedSize,,) = _leg(ev);
        _marketSell(other, placedSize);
        (bool active,,,) = ev.kuruOrderState(0);
        assertFalse(active, "filled");
        assertLe(ev.heldCost(0), cap, "cost of both venues' fills stays under the cap");
        assertApproxEqAbs(ev.totalAssets(), ta, 2, "fills move value from cash to cost");
        ev.refreshBids();
        assertLe(ev.heldCost(0), _cap(ev));
        (uint256 units,) = ev.kuruFills(0);
        assertGt(units, 0);
    }

    /* ------------------------------ Kuru unreachable ------------------------------ */

    function test_fork_kuru_softPause_cancelsStillWork_orderReturnsAfterResume() public {
        _deposit(ev, depositor, 1_000e6);
        _setMarketState(1);
        // Cancels still work while soft-paused, so the sync succeeds; only the new order is refused.
        _fund(ev, other, 100e6);
        vm.expectEmit(true, false, false, true, address(ev));
        emit SelioVault.KuruUnavailable(0, abi.encodeWithSelector(MARKET_STATE_ERROR));
        vm.prank(other);
        ev.deposit(100e6, other, 0);
        (uint40 orderId,,, uint256 escrow,) = _leg(ev);
        assertEq(orderId, 0, "no Kuru order while paused");
        assertEq(escrow, 0);
        (uint256 maxAssets, uint256 selioEscrow) = _selioBid(ev);
        // The whole room, 20% of 1,100 USDT0 less Kuru's rounding wei booked at the sync, is on the Selio bid.
        assertApproxEqAbs(selioEscrow, 220e6, 2, "the Kuru share went back to the Selio bid");
        assertEq(maxAssets, selioEscrow);
        uint256 all = ev.balanceOf(other);
        vm.prank(other);
        ev.redeem(all, other, other, new uint256[](0));
        (, uint256 wad) = ev.kuruClaimOf(other, 0);
        assertEq(wad, 0, "nothing deferred: the leg was reachable");
        _setMarketState(0);
        ev.refreshBids();
        (orderId,,,,) = _leg(ev);
        assertGt(orderId, 0, "re-quoted once Kuru resumes");
    }

    function test_fork_kuru_hardPause_operationsSucceed_claimDeferredThenPaid() public {
        _deposit(ev, depositor, 1_000e6);
        _deposit(ev, other, 1_000e6);
        // The vault's Kuru order fills partly, then the market is hard-paused before any vault operation.
        (,, uint96 placedSize,,) = _leg(ev);
        _marketSell(seller, placedSize / 2);
        (bool active, uint96 rest, uint256 refund, uint256 pending) = ev.kuruOrderState(0);
        assertTrue(active);
        _setMarketState(2);

        // Every operation still succeeds, and the leg stays as it was.
        _fund(ev, gifter, 10e6);
        vm.expectEmit(true, false, false, true, address(ev));
        emit SelioVault.KuruUnavailable(0, abi.encodeWithSelector(MARKET_STATE_ERROR));
        vm.prank(gifter);
        ev.deposit(10e6, gifter, 0);
        ev.refreshBids();
        (bool active2, uint96 rest2,,) = ev.kuruOrderState(0);
        assertTrue(active2);
        assertEq(rest2, rest, "the leg is static while paused");

        // Redemption pays the reachable cash now and defers the leg's share.
        uint256 shares = ev.balanceOf(depositor);
        uint256 denom = ev.totalSupply() + 1_000;
        uint256 legCash = refund;
        uint256 expected = (ev.idleAssets() - legCash) * shares / denom;
        vm.expectEmit(true, true, false, false, address(ev));
        emit SelioVault.KuruClaimDeferred(depositor, 0, 0, 0);
        vm.prank(depositor);
        (uint256 assets,,) = ev.redeem(shares, depositor, depositor, new uint256[](0));
        assertApproxEqAbs(assets, expected, 1, "cash excluding the unreachable leg");
        (uint64 epoch, uint256 wad) = ev.kuruClaimOf(depositor, 0);
        assertEq(epoch, 0);
        assertApproxEqAbs(wad, shares * 1e18 / denom, 1, "the redeemer's fraction of the leg");
        vm.prank(depositor);
        vm.expectRevert(SelioVault.NothingToClaim.selector);
        ev.claimKuru(0, depositor);

        // Recovery still works while Kuru is paused, once the pool is liquid again.
        deal(USDT0, gifter, 10_000e6);
        vm.startPrank(gifter);
        IERC20(USDT0).approve(address(POOL), 10_000e6);
        POOL.supply(USDT0, 10_000e6, gifter, 0);
        vm.stopPrank();
        _marketSellOnSelio();
        ev.recover(0, type(uint256).max);

        // Kuru resumes: the next operation's sync resolves the epoch and the claim pays its share of the leg.
        _setMarketState(0);
        ev.refreshBids();
        uint256 cashBefore = IERC20(USDT0).balanceOf(depositor);
        vm.prank(depositor);
        (uint256 cash, uint256 receipts) = ev.claimKuru(0, depositor);
        assertEq(IERC20(USDT0).balanceOf(depositor) - cashBefore, cash);
        assertApproxEqAbs(cash, refund * wad / 1e18, 2, "share of the cancel refund");
        uint256 pendingFace = WA.convertToAssets(uint256(placedSize) - rest);
        assertApproxEqAbs(receipts, pendingFace * wad / 1e18, 3, "share of the fills, in aMonUSDT0");
        assertApproxEqAbs(cash + receipts, (refund + pendingFace) * wad / 1e18, 4);
        assertGt(pending, 0);
        (, wad) = ev.kuruClaimOf(depositor, 0);
        assertEq(wad, 0, "paid once");
        vm.prank(depositor);
        vm.expectRevert(SelioVault.NothingToClaim.selector);
        ev.claimKuru(0, depositor);
    }

    /// @dev A seller sells into the vault's Selio bid, so the vault holds tracked receipts to recover.
    function _marketSellOnSelio() internal {
        _aTokens(seller, 50e6);
        vm.startPrank(seller);
        IERC20(A_USDT0).approve(address(market), type(uint256).max);
        market.sellNow(50e6, _ids(ev.bidOf(0)), 5_000, uint8(1 << PAY_USDT0), 1);
        vm.stopPrank();
    }

    function test_fork_kuru_marginAccountPaused_redeemDefersClaim() public {
        _deposit(ev, depositor, 1_000e6);
        vm.prank(KURU_OWNER);
        IKuruTestOnly(address(MA)).toggleProtocolState(true);
        uint256 shares = ev.balanceOf(depositor) / 2;
        vm.prank(depositor);
        (uint256 assets,,) = ev.redeem(shares, depositor, depositor, new uint256[](0));
        assertGt(assets, 0);
        (, uint256 wad) = ev.kuruClaimOf(depositor, 0);
        assertGt(wad, 0);
        vm.prank(KURU_OWNER);
        IKuruTestOnly(address(MA)).toggleProtocolState(false);
        ev.refreshBids();
        vm.prank(depositor);
        (uint256 cash,) = ev.claimKuru(0, depositor);
        assertGt(cash, 0);
    }

    /* ------------------------------ Routed sale ------------------------------ */

    /// @dev A Selio bid at 3% for 50 USDT0 of face and a Kuru bid at 980,000 (2.2%) for 20 waMonUSDT0.
    function _bothBooks() internal returns (uint256 bidId) {
        uint256 escrow = market.quote(50e6, 300, USDT0);
        deal(USDT0, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(USDT0).approve(address(market), escrow);
        bidId = market.placeBid(300, PAY_USDT0, 50e6, escrow);
        vm.stopPrank();
        _kuruBid(other, 980_000, 20e6);
    }

    function _order(uint256 bidId, uint256 kuruMinOut) internal view returns (KuruSellRouter.SellOrder memory o) {
        o.selioAssets = 30e6;
        o.bidIds = _ids(bidId);
        o.maxDiscountBps = 5_000;
        o.payMask = uint8(1 << PAY_USDT0);
        o.selioMinFilled = 30e6;
        // Enough aMonUSDT0 to wrap into the level's 20 shares.
        o.kuruAssets = _aTokensFor(20e6);
        o.kuruMinOut = kuruMinOut;
        o.to = address(0);
    }

    function test_fork_kuru_router_mixedSale_feesLeftoversAndEvent() public {
        uint256 bidId = _bothBooks();
        KuruSellRouter.SellOrder memory o = _order(bidId, 19_600_000);
        _aTokens(seller, 60e6);
        uint256 aBefore = IERC20(A_USDT0).balanceOf(seller);
        vm.startPrank(seller);
        IERC20(A_USDT0).approve(address(router), o.selioAssets + o.kuruAssets + 30);
        vm.expectEmit(true, true, false, false, address(router));
        emit KuruSellRouter.KuruRoutedSale(seller, seller, 0, 0, 0, 0, 0);
        (uint256 selioFilled, uint256[] memory selioPaid, uint256 kuruOut) = router.sell(o);
        vm.stopPrank();
        assertEq(selioFilled, 30e6);
        assertEq(selioPaid[0], market.quote(30e6, 300, USDT0));
        assertEq(kuruOut, 19_600_000, "20 shares at 0.98, Kuru taker fee 0");
        uint256 fee = market.feeOf(selioPaid[0]);
        assertEq(IERC20(USDT0).balanceOf(treasury), fee, "Selio's fee on the Selio leg only");
        assertEq(IERC20(USDT0).balanceOf(seller), selioPaid[0] - fee + kuruOut, "the seller receives both legs");
        assertApproxEqAbs(
            aBefore - IERC20(A_USDT0).balanceOf(seller),
            30e6 + IERC4626(address(WA)).previewMint(20e6),
            3,
            "receipts sold: unsold base came back unwrapped"
        );
        address[5] memory tokens = [USDT0, A_USDT0, address(WA), AUSD, USDC];
        for (uint256 k; k < tokens.length; ++k) {
            assertEq(IERC20(tokens[k]).balanceOf(address(router)), 0, "the router keeps nothing");
        }
        assertEq(IERC20(A_USDT0).allowance(address(router), address(market)), 0);
        assertEq(IERC20(address(WA)).allowance(address(router), address(book)), 0);
    }

    function test_fork_kuru_router_kuruMinOutRevert_revertsBothLegs() public {
        uint256 bidId = _bothBooks();
        KuruSellRouter.SellOrder memory o = _order(bidId, 19_600_001);
        _aTokens(seller, 60e6);
        uint256 aBefore = IERC20(A_USDT0).balanceOf(seller);
        (, uint256 escrowBefore) = _escrowOf(bidId);
        vm.startPrank(seller);
        IERC20(A_USDT0).approve(address(router), o.selioAssets + o.kuruAssets + 30);
        vm.expectRevert(SLIPPAGE_EXCEEDED);
        router.sell(o);
        vm.stopPrank();
        (, uint256 escrowAfter) = _escrowOf(bidId);
        assertEq(escrowAfter, escrowBefore, "the Selio leg reverted too");
        assertEq(IERC20(A_USDT0).balanceOf(seller), aBefore);
        assertEq(IERC20(USDT0).balanceOf(treasury), 0);
    }

    function _escrowOf(uint256 bidId) internal view returns (address bidderOf, uint256 escrow) {
        (bidderOf,,,, escrow) = market.bids(bidId);
    }

    function test_fork_kuru_router_andVault_rejectMismatchedBook() public {
        // A waMonUSDT0 market quoted in USDC instead of the underlying.
        IKuruOrderBook usdcBook = harness.kuruMarket(KURU_ROUTER, address(WA), USDC);
        vm.expectRevert(KuruSellRouter.BadParams.selector);
        new KuruSellRouter(market, usdcBook, WA);
        // The right book with another wrapper, or with no wrapper at all (the book then must trade aMonUSDT0).
        vm.expectRevert(KuruSellRouter.BadParams.selector);
        new KuruSellRouter(market, book, IStataToken(WA_MON_USDC));
        vm.expectRevert(KuruSellRouter.BadParams.selector);
        new KuruSellRouter(market, book, IStataToken(address(0)));
        // The vault applies the same checks to its Kuru leg.
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        SelioVault.KuruLeg[] memory legs = new SelioVault.KuruLeg[](1);
        legs[0] = SelioVault.KuruLeg(usdcBook, MA, WA);
        vm.expectRevert(SelioVault.BadParams.selector);
        new SelioVault(
            "x", "x", IERC20(USDT0), markets, minD, maxShare, IERC4626(address(0)), ISourceProbe(address(0)), legs, 5_000
        );
    }

    function test_fork_kuru_router_views() public view {
        assertEq(router.facePerBase(), F);
        ExitMarket.Capacity memory c = router.exitCapacity();
        assertEq(c.withdrawable, 0, "the USDT0 reserve is frozen");
        assertGt(c.supplied, 0);
        assertEq(c.utilizationBps, 10_000);
        assertEq(address(router.base()), address(WA));
        assertEq(address(router.quote()), USDT0);
        assertEq(address(router.receipt()), A_USDT0);
    }
}
