// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoStack} from "../../script/lib/MorphoStack.sol";
import {KuruDeployHarness} from "../utils/KuruDeployHarness.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {KuruSellRouter} from "../../src/kuru/KuruSellRouter.sol";
import {KuruMath} from "../../src/kuru/KuruMath.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";
import {IKuruOrderBook, IKuruMarginAccount, IKuruRouter, KuruMarketParams} from "../../src/shared/interfaces/IKuru.sol";
import {IStataToken} from "../../src/shared/interfaces/IStataToken.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {FixedMorphoOracle} from "../../src/testnet/FixedMorphoOracle.sol";

/// @notice Kuru on a fork of Monad testnet with Selio's Morpho stack deployed on the fork: an eUSDC/USDC market
/// created against the live testnet Router, the Selio Vault quoting Vault V2 shares there, and a routed sale of shares
/// (no wrapper). Skips when `MONAD_TESTNET_RPC` is unset or empty.
contract KuruTestnetForkTest is Test, MorphoStack {
    IKuruRouter internal constant KURU_ROUTER = IKuruRouter(0x7EFbE105Ca7415dE98F96622173458ac1c054630);
    IKuruMarginAccount internal constant MA = IKuruMarginAccount(0xd029C2D98ff85D8F64799017fE00a59B1159CE02);
    /// @dev Circle testnet USDC, the quote Selio uses on Monad testnet.
    address internal constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    uint8 internal constant PAY_USDC = 0;

    Stack internal s;
    IVaultV2 internal earn;
    MorphoVaultExitMarket internal market;
    KuruDeployHarness internal harness;
    IKuruOrderBook internal book;
    KuruSellRouter internal router;
    SelioVault internal ev;
    TestToken internal ausd;
    address internal treasury = makeAddr("treasury");
    address internal depositor = makeAddr("depositor");
    address internal seller = makeAddr("seller");
    address internal bidder = makeAddr("bidder");
    address internal kuruBidder = makeAddr("kuruBidder");

    function setUp() public {
        string memory rpc = vm.envOr("MONAD_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        ausd = new TestToken("Simulated AUSD", "AUSD-sim", 18, 1_000_000 ether);
        FixedMorphoOracle oracle = new FixedMorphoOracle(1e24);
        s = _buildMorphoStack(address(this), USDC, address(ausd), address(oracle), "Earn USDC (sim)", "eUSDC");
        earn = s.vault;
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (USDC, address(ausd));
        address[] memory feeds = new address[](2);
        (feeds[0], feeds[1]) = (address(new FixedPriceFeed(1e8, 8)), address(new FixedPriceFeed(1e8, 8)));
        uint256[] memory ages = new uint256[](2);
        (ages[0], ages[1]) = (2 days, 2 days);
        uint256[] memory minEscrows = new uint256[](2);
        (minEscrows[0], minEscrows[1]) = (1, 1);
        PriceRouter prices = new PriceRouter(tokens, feeds, ages);
        market = new MorphoVaultExitMarket(s.morpho, earn, s.adapter, prices, tokens, minEscrows, treasury);
        harness = new KuruDeployHarness();
        book = harness.kuruMarket(KURU_ROUTER, address(earn), USDC);
        router = new KuruSellRouter(market, book, IStataToken(address(0)));
        ev = _vault();
        // The Earn vault has depositors, so its shares are worth their face.
        _earnShares(makeAddr("earnDepositor"), 1_000e6);
    }

    function _vault() internal returns (SelioVault) {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = 300;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        SelioVault.KuruLeg[] memory legs = new SelioVault.KuruLeg[](1);
        legs[0] = SelioVault.KuruLeg(book, MA, IStataToken(address(0)));
        return new SelioVault(
            "Selio Vault USDC",
            "slUSDC",
            IERC20(USDC),
            markets,
            minD,
            maxShare,
            IERC4626(address(0)),
            ISourceProbe(address(0)),
            legs,
            5_000
        );
    }

    function _earnShares(address who, uint256 usdc) internal returns (uint256 shares) {
        deal(USDC, who, usdc);
        vm.startPrank(who);
        IERC20(USDC).approve(address(earn), usdc);
        shares = earn.deposit(usdc, who);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 amount) internal {
        deal(USDC, who, amount);
        vm.startPrank(who);
        IERC20(USDC).approve(address(ev), amount);
        ev.deposit(amount, who, 0);
        vm.stopPrank();
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function test_forkTestnet_kuru_marketCreatedAgainstLiveRouter() public {
        KuruMarketParams memory p = book.getMarketParams();
        assertEq(p.pricePrecision, 1e6);
        assertEq(p.sizePrecision, 1e6);
        assertEq(p.base, address(earn), "Vault V2 shares are the base, no wrapper");
        assertEq(p.baseDecimals, 18);
        assertEq(p.quote, USDC);
        assertEq(p.quoteDecimals, 6);
        assertEq(p.tickSize, 100);
        assertEq(p.minSize, 1e6);
        assertEq(p.maxSize, 1e15);
        assertEq(p.takerFeeBps, 0);
        assertEq(p.makerFeeBps, 0);
        assertEq(KURU_ROUTER.verifiedMarket(address(book)).base, address(earn));
        assertEq(address(harness.kuruMarket(KURU_ROUTER, address(earn), USDC)), address(book), "reused");
        assertEq(router.facePerBase(), earn.previewRedeem(1e18));
    }

    function test_forkTestnet_kuru_vaultOrderWithVaultShares() public {
        _deposit(depositor, 1_000e6);
        (,,, uint40 orderId, uint32 price, uint96 placedSize, uint256 escrow,) = ev.kuruLeg(0);
        KuruMarketParams memory p = book.getMarketParams();
        uint256 face = earn.previewRedeem(1e18);
        assertGt(orderId, 0);
        assertEq(price % p.tickSize, 0);
        assertGe(KuruMath.discountOf(price, face, p), 300);
        assertEq(placedSize, KuruMath.sizeFor(price, face, 100e6, 100e6, p), "half of the 200 USDC room");
        assertEq(escrow, KuruMath.debit(price, placedSize, p));
        (,,,, uint256 selioEscrow) = market.bids(ev.bidOf(0));
        assertLe(escrow + selioEscrow, 200e6);

        // A seller sells 10 shares into the vault's Kuru bid; the next operation books them at cost, as shares.
        uint256 shares = _earnShares(seller, 20e6);
        vm.startPrank(seller);
        IERC20(address(earn)).approve(address(book), 10e18);
        uint256 out = book.placeAndExecuteMarketSell(10e6, 0, false, false);
        vm.stopPrank();
        assertEq(out, KuruMath.refundValue(10e6, price, p), "paid at the vault's price");
        assertEq(IERC20(address(earn)).balanceOf(seller), shares - 10e18);
        uint256 ta = ev.totalAssets();
        ev.refreshBids();
        (uint256 units, uint256 paid) = ev.kuruFills(0);
        assertEq(units, 10e18, "shares are the units");
        assertEq(paid, escrow - KuruMath.refundValue(placedSize - 10e6, price, p));
        assertEq(IERC20(address(earn)).balanceOf(address(ev)), 10e18);
        assertApproxEqAbs(ev.totalAssets(), ta, 2);
        assertLe(ev.heldCost(0), ev.totalAssets() / 5);
    }

    function test_forkTestnet_kuru_routedSaleWithShares() public {
        uint256 escrow = market.quote(50e6, 300, USDC);
        deal(USDC, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(USDC).approve(address(market), escrow);
        uint256 bidId = market.placeBid(300, PAY_USDC, 50e6, escrow);
        vm.stopPrank();
        uint256 debit = KuruMath.debit(980_000, 20e6, book.getMarketParams());
        deal(USDC, kuruBidder, debit);
        vm.startPrank(kuruBidder);
        IERC20(USDC).approve(address(MA), debit);
        MA.deposit(kuruBidder, USDC, debit);
        book.addBuyOrder(980_000, 20e6, true);
        vm.stopPrank();

        uint256 shares = _earnShares(seller, 60e6);
        KuruSellRouter.SellOrder memory o;
        o.selioAssets = 30e6;
        o.bidIds = _ids(bidId);
        o.maxDiscountBps = 5_000;
        o.payMask = uint8(1 << PAY_USDC);
        o.selioMinFilled = 30e6;
        o.kuruAssets = earn.previewRedeem(20e18) + 1;
        o.kuruMinOut = 19_600_000;
        vm.startPrank(seller);
        IERC20(address(earn)).approve(address(router), earn.previewWithdraw(o.selioAssets + o.kuruAssets) + 2);
        (uint256 selioFilled, uint256[] memory selioPaid, uint256 kuruOut) = router.sell(o);
        vm.stopPrank();
        assertEq(selioFilled, 30e6);
        assertEq(kuruOut, 19_600_000, "20 shares at 0.98");
        uint256 fee = market.feeOf(selioPaid[0]);
        assertEq(IERC20(USDC).balanceOf(treasury), fee, "Selio's fee on the Selio leg only");
        assertEq(IERC20(USDC).balanceOf(seller), selioPaid[0] - fee + kuruOut);
        assertLt(IERC20(address(earn)).balanceOf(seller), shares - 49e18);
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "the router keeps nothing");
        assertEq(IERC20(address(earn)).balanceOf(address(router)), 0);
        assertEq(IERC20(address(ausd)).balanceOf(address(router)), 0);
    }
}
