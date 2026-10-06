// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMorpho, MarketParams, Authorization, Signature} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoStack} from "../../script/lib/MorphoStack.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {SelioVault} from "../../src/vault/SelioVault.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {ISourceProbe} from "../../src/shared/interfaces/ISourceProbe.sol";
import {MockERC20} from "../utils/MockERC20.sol";
import {MockMorphoOracle} from "../utils/MockMorphoOracle.sol";

/// @notice Local Earn-like environment: a USDC Vault V2 fully lent out in one Morpho market (frozen), plus a separate
/// liquid market that gives Morpho flash-loan liquidity.
abstract contract MorphoBase is Test, MorphoStack {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    bytes32 internal constant AUTHORIZATION_TYPEHASH =
        keccak256("Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)");
    uint256 internal constant USD = 1e6;
    /// @dev 1 sim-AUSD (18 dec) = 1 USDC (6 dec), scaled 1e36
    uint256 internal constant ORACLE_PRICE = 1e24;
    uint8 internal constant PAY_USDC = 0;
    uint8 internal constant PAY_AUSD = 1;

    address internal seller = makeAddr("seller");
    address internal whale = makeAddr("whale");
    address internal flashLender = makeAddr("flashLender");
    address internal bidder = makeAddr("bidder");
    address internal keeper = makeAddr("keeper");
    address internal treasury = makeAddr("treasury");
    uint256 internal buyerKey = 0xB0B;
    address internal buyer = vm.addr(buyerKey);

    MockERC20 internal usdc;
    MockERC20 internal ausd;
    MockMorphoOracle internal oracle;
    Stack internal s;
    IMorpho internal morpho;
    IVaultV2 internal vault;
    PriceRouter internal prices;
    MorphoVaultExitMarket internal market;

    function setUp() public virtual {
        vm.warp(1_780_000_000);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        ausd = new MockERC20("Simulated AUSD", "AUSD-sim", 18);
        oracle = new MockMorphoOracle(ORACLE_PRICE);
        s = _buildMorphoStack(address(this), address(usdc), address(ausd), address(oracle), "Earn USDC", "eUSDC");
        morpho = s.morpho;
        vault = s.vault;
        prices = new PriceRouter(
            _pair(address(usdc), address(ausd)),
            _pair(address(new FixedPriceFeed(1e8, 8)), address(new FixedPriceFeed(1e8, 8))),
            _uintPair(1 days, 1 days)
        );
        market = _newMarket(prices, _pair(address(usdc), address(ausd)));
        // Depositors: the seller holds 1,000,000 USDC of vault shares, allocated to the earn market.
        _depositToVault(seller, 1_000_000 * USD);
        // Separate liquid market: Morpho holds idle USDC that can be flash-borrowed
        _supplyFlashMarket(200_000 * USD);
        // Borrowers drain the earn market to 100% utilization
        _borrow(buyer, 400_000 ether, 300_000 * USD);
        _borrow(whale, 1_000_000 ether, 700_000 * USD);
    }

    /* ------------------------------ Deployment helpers ------------------------------ */

    /// @dev A market on the local vault with a minimum bid escrow of 1 per pay token and `treasury` as fee recipient.
    function _newMarket(PriceRouter router, address[] memory payTokens) internal returns (MorphoVaultExitMarket) {
        uint256[] memory minEscrows = new uint256[](payTokens.length);
        for (uint256 i; i < payTokens.length; ++i) {
            minEscrows[i] = 1;
        }
        return new MorphoVaultExitMarket(morpho, vault, s.adapter, router, payTokens, minEscrows, treasury);
    }

    /// @dev The USDC Selio Vault of the tests: one strategy on `market`, 3% minimum discount, 20% cap, no yield source.
    function _newVault() internal returns (SelioVault) {
        return _newVault(IERC4626(address(0)), ISourceProbe(address(0)));
    }

    function _newVault(IERC4626 source, ISourceProbe probe) internal returns (SelioVault) {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = 300;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        return new SelioVault("Selio Vault USDC", "slUSDC", IERC20(address(usdc)), markets, minD, maxShare, source, probe);
    }

    function _pair(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function _uintPair(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    /* ------------------------------ Position helpers ------------------------------ */

    function _depositToVault(address who, uint256 amount) internal returns (uint256 shares) {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _supplyFlashMarket(uint256 amount) internal {
        usdc.mint(flashLender, amount);
        vm.startPrank(flashLender);
        usdc.approve(address(morpho), amount);
        morpho.supply(s.flashMarket, amount, 0, flashLender, "");
        vm.stopPrank();
    }

    /// @dev Lowers the flash chunk.
    function _withdrawFlashMarket(uint256 amount) internal {
        vm.prank(flashLender);
        morpho.withdraw(s.flashMarket, amount, 0, flashLender, flashLender);
    }

    function _borrow(address who, uint256 collateral, uint256 amount) internal {
        ausd.mint(who, collateral);
        vm.startPrank(who);
        ausd.approve(address(morpho), collateral);
        morpho.supplyCollateral(s.earnMarket, collateral, who, "");
        morpho.borrow(s.earnMarket, amount, 0, who, who);
        vm.stopPrank();
    }

    function _debt(address who) internal view returns (uint256) {
        return morpho.expectedBorrowAssets(s.earnMarket, who);
    }

    function _withdrawable() internal view returns (uint256) {
        return market.capacity().withdrawable;
    }

    /* ------------------------------ Market helpers ------------------------------ */

    function _defaultParams() internal pure returns (ExitMarket.SessionParams memory p) {
        p = ExitMarket.SessionParams({
            startBps: 100, stepBps: 50, stepInterval: 1 hours, capBps: 1000, duration: 7 days, payMask: 0x03
        });
    }

    function _openSession(uint256 assets) internal returns (uint256 id) {
        return _openSession(assets, _defaultParams());
    }

    function _openSession(uint256 assets, ExitMarket.SessionParams memory p) internal returns (uint256 id) {
        uint256 shares = vault.previewWithdraw(assets);
        vm.startPrank(seller);
        vault.approve(address(market), shares);
        id = market.openSession(shares, p);
        vm.stopPrank();
    }

    function _venue(bool force, bytes memory auth) internal view returns (bytes memory) {
        return abi.encode(s.earnMarket, force, auth);
    }

    function _signAuth(uint256 key, address authorizer, bool isAuthorized, uint256 nonce)
        internal
        view
        returns (Authorization memory a, Signature memory sig)
    {
        a = Authorization({
            authorizer: authorizer,
            authorized: address(market),
            isAuthorized: isAuthorized,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
        bytes32 digest = keccak256(
            bytes.concat("\x19\x01", morpho.DOMAIN_SEPARATOR(), keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a)))
        );
        (sig.v, sig.r, sig.s) = vm.sign(key, digest);
    }

    function _authBundle(uint256 key, address who) internal view returns (bytes memory) {
        uint256 n = morpho.nonce(who);
        (Authorization memory grant, Signature memory grantSig) = _signAuth(key, who, true, n);
        (Authorization memory revoke, Signature memory revokeSig) = _signAuth(key, who, false, n + 1);
        return abi.encode(grant, grantSig, revoke, revokeSig);
    }
}
