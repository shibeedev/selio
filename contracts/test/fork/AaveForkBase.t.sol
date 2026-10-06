// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {AaveExitMarket} from "../../src/venues/aave/AaveExitMarket.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {AnswerOnlyFeed, IAnswerAggregator} from "../../src/shared/oracle/AnswerOnlyFeed.sol";
import {IAavePool} from "../../src/shared/interfaces/IAaveV3.sol";

/// @notice Fork of Monad mainnet with the live Aave V3 market. Our actors supply and borrow on the real pool; the
/// pool's USDC liquidity is then withdrawn so the pool is frozen (utilization ~100%).
abstract contract AaveForkBase is Test {
    using stdStorage for StdStorage;

    IAavePool internal constant POOL = IAavePool(0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef);
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant A_USDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    address internal constant V_USDC = 0x9F555aB84C4e0a531B50283f09Dba7A97134c4e4;
    address internal constant WETH = 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242;
    address internal constant A_WETH = 0x4377b53aAA8b8e3fF7AA2843832CAF004f5Cb8b6;
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant A_AUSD = 0xdeBFeDF35faEd5d1664E553545e144C02227A2Ec;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant A_USDT0 = 0x9531E6bC99D7F7f0596ed7bA5b846Ba9Eb60468c;
    address internal constant MORPHO = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
    address internal constant AUSD_USD_FEED = 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13;
    address internal constant USDC_USD_FEED = 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec;
    address internal constant ETH_USD_FEED = 0x1B1414782B859871781bA3E4B0979b9ca57A0A04;
    address internal constant USDT0_USD_FEED = 0x109959f1Aa3d05dF1F4eA965d6eAE5c1c8358885;
    /// @dev Aave's static aToken for USDC (waMonUSDC), the largest aMonUSDC holder and the vault-freeze yield source.
    address internal constant STATIC_A_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2;
    uint8 internal constant PAY_AUSD = 0;
    uint8 internal constant PAY_USDC = 1;
    uint8 internal constant PAY_USDT0 = 2;
    uint8 internal constant PAY_WETH = 3;

    PriceRouter internal prices;
    AaveExitMarket internal market;
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal whale = makeAddr("whale");
    address internal bidder = makeAddr("bidder");
    address internal treasury = makeAddr("treasury");
    bool internal forked;

    function setUp() public virtual {
        string memory rpc = vm.envOr("MONAD_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        // The public RPC is not an archive node, so fork the latest block unless a block is pinned.
        uint256 pinned = vm.envOr("MONAD_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, pinned);
        forked = true;

        address[] memory tokens = new address[](4);
        (tokens[0], tokens[1], tokens[2], tokens[3]) = (AUSD, USDC, USDT0, WETH);
        address[] memory feeds = new address[](4);
        address usdt0Feed = address(new AnswerOnlyFeed(IAnswerAggregator(USDT0_USD_FEED)));
        (feeds[0], feeds[1], feeds[2], feeds[3]) = (AUSD_USD_FEED, USDC_USD_FEED, usdt0Feed, ETH_USD_FEED);
        uint256[] memory ages = new uint256[](4);
        (ages[0], ages[1], ages[2], ages[3]) = (2 days, 2 days, 2 days, 2 days);
        prices = new PriceRouter(tokens, feeds, ages);
        market = _deployMarket(IMorpho(address(0)));
    }

    function _deployMarket(IMorpho externalFlash) internal returns (AaveExitMarket m) {
        address[] memory payTokens = new address[](4);
        (payTokens[0], payTokens[1], payTokens[2], payTokens[3]) = (AUSD, USDC, USDT0, WETH);
        address[] memory payATokens = new address[](4);
        (payATokens[0], payATokens[1], payATokens[2], payATokens[3]) = (A_AUSD, address(0), A_USDT0, A_WETH);
        uint256[] memory minEscrows = new uint256[](4);
        (minEscrows[0], minEscrows[1], minEscrows[2], minEscrows[3]) = (1, 1, 1, 1);
        m = new AaveExitMarket(POOL, A_USDC, V_USDC, prices, payTokens, payATokens, externalFlash, minEscrows, treasury);
    }

    function _supplyWeth(address who, uint256 amount) internal {
        _supply(who, WETH, amount);
    }

    function _supplyUsdc(address who, uint256 amount) internal {
        _supply(who, USDC, amount);
    }

    function _supply(address who, address asset, uint256 amount) internal {
        deal(asset, who, amount);
        vm.startPrank(who);
        IERC20(asset).approve(address(POOL), amount);
        POOL.supply(asset, amount, who, 0);
        vm.stopPrank();
    }

    /// @dev AUSD keeps each balance shifted left by 8 bits (the low byte holds account flags), which `deal` cannot
    /// write; set the balance word directly.
    function _dealAusd(address to, uint256 amount) internal {
        uint256 slot = stdstore.target(AUSD).sig(IERC20.balanceOf.selector).with_key(to).find();
        vm.store(AUSD, bytes32(slot), bytes32(amount << 8));
        assertEq(IERC20(AUSD).balanceOf(to), amount);
    }

    function _borrow(address who, address asset, uint256 amount) internal {
        vm.prank(who);
        POOL.borrow(asset, amount, 2, 0, who);
    }

    /// @dev The pool's withdrawable USDC: Aave's virtual balance, which USDC sent to aMonUSDC directly does not raise.
    function _usdcLiquidity() internal view returns (uint256) {
        return POOL.getVirtualUnderlyingBalance(USDC);
    }

    /// @dev USDC leaves the pool until only `leave` remains withdrawable. Aave's USDC borrow cap on Monad can leave less
    /// headroom than the pool's liquidity (it did on 13 Oct 2026), so the largest aMonUSDC holder withdraws it.
    function _freeze(uint256 leave) internal {
        uint256 liquidity = _usdcLiquidity();
        if (liquidity <= leave) return;
        vm.prank(STATIC_A_USDC);
        POOL.withdraw(USDC, liquidity - leave, whale);
    }

    /// @dev Liquidity returns to the frozen pool.
    function _unfreeze(uint256 amount) internal {
        _supplyUsdc(whale, amount);
    }

    /// @dev WETH worth `usd` dollars at the oracle price.
    function _wethFor(uint256 usd) internal view returns (uint256) {
        return usd * 1e8 * 1e18 / prices.priceOf(WETH);
    }

    /// @dev Standard scene: seller holds 100 aMonUSDC, buyer owes 60 USDC against WETH, pool frozen to `leave`.
    function _scene(uint256 leave) internal {
        _supplyUsdc(seller, 100e6);
        _supplyWeth(buyer, _wethFor(200));
        _borrow(buyer, USDC, 60e6);
        _freeze(leave);
    }

    function _params() internal pure returns (ExitMarket.SessionParams memory) {
        return ExitMarket.SessionParams({
            startBps: 100, stepBps: 50, stepInterval: 1 hours, capBps: 1500, duration: 7 days, payMask: 0x0F
        });
    }

    function _openSession(uint256 amount) internal returns (uint256 id) {
        vm.startPrank(seller);
        IERC20(A_USDC).approve(address(market), amount);
        id = market.openSession(amount, _params());
        vm.stopPrank();
    }

    function _debt(address who) internal view returns (uint256) {
        return IERC20(V_USDC).balanceOf(who);
    }

    function _hf(address who) internal view returns (uint256 hf) {
        (,,,,, hf) = POOL.getUserAccountData(who);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }
}
