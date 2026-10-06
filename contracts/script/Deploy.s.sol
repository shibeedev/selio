// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoStack} from "./lib/MorphoStack.sol";
import {ExitMarket} from "../src/market/ExitMarket.sol";
import {AaveExitMarket} from "../src/venues/aave/AaveExitMarket.sol";
import {MorphoVaultExitMarket} from "../src/venues/morpho/MorphoVaultExitMarket.sol";
import {SelioVault} from "../src/vault/SelioVault.sol";
import {AaveSourceProbe} from "../src/vault/probes/AaveSourceProbe.sol";
import {MorphoVaultSourceProbe} from "../src/vault/probes/MorphoVaultSourceProbe.sol";
import {AaveCollateralRoute} from "../src/route/AaveCollateralRoute.sol";
import {KuruSellRouter} from "../src/kuru/KuruSellRouter.sol";
import {PriceRouter} from "../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../src/shared/oracle/FixedPriceFeed.sol";
import {AnswerOnlyFeed, IAnswerAggregator} from "../src/shared/oracle/AnswerOnlyFeed.sol";
import {IAavePool} from "../src/shared/interfaces/IAaveV3.sol";
import {IKuruOrderBook, IKuruMarginAccount, IKuruRouter} from "../src/shared/interfaces/IKuru.sol";
import {ISourceProbe} from "../src/shared/interfaces/ISourceProbe.sol";
import {IStataToken} from "../src/shared/interfaces/IStataToken.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {FixedMorphoOracle} from "../src/testnet/FixedMorphoOracle.sol";

/// @notice Deploys Selio to one network. DEPLOY_NETWORK selects: usdt0-replay (Monad mainnet fork at the 7 Aug 2026
/// Aave USDT0 freeze (aMonUSDT0, Morpho as external flash)), monad-testnet (self-deployed Morpho + Vault V2 shaped
/// like a USDC Earn vault (USDC Earn shares), plus a second vault as the Selio Vault's base-yield source),
/// vault-freeze (Monad mainnet fork against the live Hyperithm USDC Apex Earn vault, base yield in Aave's static
/// aToken for USDC). On usdt0-replay (waMonUSDT0/USDT0) and monad-testnet (eUSDC/USDC) it also creates the receipt's
/// Kuru order-book market, or reuses it when it already exists, and deploys its `KuruSellRouter`; the Selio Vault
/// quotes there too. Writes <DEPLOY_OUT_DIR>/<network>.json (default ./deployments/; local fork runs use
/// ./deployments/local/). Every market's fee recipient is the deployer.
contract Deploy is Script, MorphoStack {
    struct AaveConfig {
        address pool;
        address aToken;
        address debtToken;
        address[] payTokens;
        address[] payATokens;
        address[] feeds;
        address externalFlash;
        uint256[] maxAges;
        uint256[] minEscrows;
    }

    /// @dev Kuru on one network; `router == address(0)` means no Kuru market there.
    struct KuruConfig {
        IKuruRouter router;
        IKuruMarginAccount margin;
        IStataToken wrapper;
    }

    uint16 internal constant VAULT_MIN_DISCOUNT_BPS = 300;
    uint16 internal constant VAULT_MAX_SHARE_BPS = 2_000;
    /// @dev Share of the Selio Vault's room under the cap quoted on Kuru.
    uint16 internal constant KURU_SHARE_BPS = 5_000;

    /// @dev Kuru market parameters (both networks): 1e-6 base per size unit and 1e-6 quote per price unit, a tick of
    /// 0.0001 quote (about 1 bp at par), at least one whole base unit per order, no Kuru fees, and the docs' AMM spread
    /// for stable markets. ERC-20 base and quote (type 0).
    uint96 internal constant KURU_SIZE_PRECISION = 1e6;
    uint32 internal constant KURU_PRICE_PRECISION = 1e6;
    uint32 internal constant KURU_TICK_SIZE = 100;
    uint96 internal constant KURU_MIN_SIZE = 1e6;
    uint96 internal constant KURU_MAX_SIZE = 1e15;
    uint256 internal constant KURU_TAKER_FEE_BPS = 0;
    uint256 internal constant KURU_MAKER_FEE_BPS = 0;
    uint96 internal constant KURU_AMM_SPREAD = 30;

    /// @dev Chainlink feeds on Monad: AUSD/USD and USDC/USD update hourly (1 h heartbeat), ETH/USD more often. A fork
    /// never receives feed updates, so the buffer keeps a daily re-created fork pricing for its whole day.
    uint256 internal constant CHAINLINK_MAX_AGE = 1 hours + 24 hours;
    /// @dev `FixedPriceFeed` and `AnswerOnlyFeed` always report the current block, so their age has no effect.
    uint256 internal constant FRESH_FEED_MAX_AGE = 2 days;

    /// @dev Minimum bid escrows, about 0.1 USD per pay token (below the smallest bids the tools place).
    uint256 internal constant MIN_ESCROW_6DP = 0.1e6;
    uint256 internal constant MIN_ESCROW_18DP_USD = 0.1e18;
    uint256 internal constant MIN_ESCROW_WETH = 0.00001e18;

    /// @dev monad-testnet base-yield seed: the deployer deposits into the yield vault and borrows part of it back
    /// against minted AUSD-sim, so the yield market pays interest.
    uint256 internal constant YIELD_SEED_DEPOSIT = 2e6;
    uint256 internal constant YIELD_SEED_BORROW = 1e6;
    uint256 internal constant YIELD_SEED_COLLATERAL = 2 ether;

    // Monad mainnet (usdt0-replay and vault-freeze forks).
    address internal constant AAVE_POOL = 0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef;
    address internal constant MORPHO = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant WETH = 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242;
    address internal constant A_AUSD = 0xdeBFeDF35faEd5d1664E553545e144C02227A2Ec;
    address internal constant A_USDC = 0x35a73BAcb179d3740395A3ceCc87FF2e581d6042;
    address internal constant A_USDT0 = 0x9531E6bC99D7F7f0596ed7bA5b846Ba9Eb60468c;
    address internal constant A_WETH = 0x4377b53aAA8b8e3fF7AA2843832CAF004f5Cb8b6;
    address internal constant USDT0_DEBT = 0x85812C8eEeB8723e3C60d0Dc78e697b4E7e5a35D;
    address internal constant AUSD_USD_FEED = 0xE20751C7B5867bCBef815ffc1b284c3f412a9e13;
    address internal constant USDC_USD_FEED = 0xf5F15f188AbCB0d165D1Edb7f37F7d6fA2fCebec;
    address internal constant ETH_USD_FEED = 0x1B1414782B859871781bA3E4B0979b9ca57A0A04;
    address internal constant USDT0_USD_AGGREGATOR = 0x109959f1Aa3d05dF1F4eA965d6eAE5c1c8358885;
    address internal constant HYPERITHM_USDC_APEX = 0x78999cc96d2Ba0341588C60CcB0E91c6C33CF371;
    address internal constant HYPERITHM_ADAPTER = 0x068F22739A5f8a5c84619D7F355b678d00707908;
    address internal constant WA_MON_USDC = 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2;
    address internal constant WA_MON_USDT0 = 0x5E7109A755fD2b86361F95065cDE07FbAb50CA1D;
    address internal constant KURU_ROUTER = 0xd651346d7c789536ebf06dc72aE3C8502cd695CC;
    address internal constant KURU_MARGIN_ACCOUNT = 0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5;
    // Monad testnet.
    address internal constant CIRCLE_TESTNET_USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    address internal constant KURU_TESTNET_ROUTER = 0x7EFbE105Ca7415dE98F96622173458ac1c054630;
    address internal constant KURU_TESTNET_MARGIN_ACCOUNT = 0xd029C2D98ff85D8F64799017fE00a59B1159CE02;

    string internal network;
    address internal deployer;
    string internal out = "deployment";

    function run() external {
        network = vm.envString("DEPLOY_NETWORK");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(pk);
        vm.serializeString(out, "network", network);
        vm.serializeUint(out, "chainId", block.chainid);
        vm.serializeUint(out, "deployBlock", block.number);
        vm.serializeAddress(out, "deployer", deployer);
        bytes32 n = keccak256(bytes(network));
        string memory dir = vm.envOr("DEPLOY_OUT_DIR", string("./deployments/"));
        // Create the output folder before broadcasting, so a path that cannot be written fails before any transaction.
        vm.createDir(dir, true);
        vm.startBroadcast(pk);
        if (n == keccak256("usdt0-replay")) _deployAave(_usdt0Replay(), "Selio Vault USDT0", "slUSDT0");
        else if (n == keccak256("monad-testnet")) _deployMonadTestnet();
        else if (n == keccak256("vault-freeze")) _deployEarnFork();
        else revert("unknown DEPLOY_NETWORK");
        vm.stopBroadcast();
        string memory json = vm.serializeString(out, "venue", _isAave(n) ? "aave" : "morpho");
        vm.writeJson(json, string.concat(dir, network, ".json"));
    }

    function _isAave(bytes32 n) internal pure returns (bool) {
        return n == keccak256("usdt0-replay");
    }

    /* ------------------------------ Aave ------------------------------ */

    function _usdt0Replay() internal returns (AaveConfig memory c) {
        c.pool = AAVE_POOL;
        c.aToken = A_USDT0;
        c.debtToken = USDT0_DEBT;
        c.externalFlash = MORPHO;
        c.payTokens = _addresses4(AUSD, USDC, USDT0, WETH);
        c.payATokens = _addresses4(A_AUSD, A_USDC, address(0), A_WETH);
        // USDT0 is priced at its market price through `latestAnswer()`: the aggregator reverts on `latestRoundData`.
        address usdt0Feed = address(new AnswerOnlyFeed(IAnswerAggregator(USDT0_USD_AGGREGATOR)));
        c.feeds = _addresses4(AUSD_USD_FEED, USDC_USD_FEED, usdt0Feed, ETH_USD_FEED);
        c.maxAges = _uints4(CHAINLINK_MAX_AGE, CHAINLINK_MAX_AGE, FRESH_FEED_MAX_AGE, CHAINLINK_MAX_AGE);
        c.minEscrows = _uints4(MIN_ESCROW_6DP, MIN_ESCROW_6DP, MIN_ESCROW_6DP, MIN_ESCROW_WETH);
    }

    function _deployAave(AaveConfig memory c, string memory vaultName, string memory vaultSymbol) internal {
        PriceRouter prices = new PriceRouter(c.payTokens, c.feeds, c.maxAges);
        AaveExitMarket market = new AaveExitMarket(
            IAavePool(c.pool),
            c.aToken,
            c.debtToken,
            prices,
            c.payTokens,
            c.payATokens,
            IMorpho(c.externalFlash),
            c.minEscrows,
            deployer
        );
        AaveExitMarket[] memory routeMarkets = new AaveExitMarket[](1);
        routeMarkets[0] = market;
        AaveCollateralRoute route = new AaveCollateralRoute(IAavePool(c.pool), routeMarkets);
        // Kuru trades the non-rebasing static wrapper of aMonUSDT0 against USDT0.
        SelioVault.KuruLeg memory leg = _deployKuru(
            market,
            KuruConfig(IKuruRouter(KURU_ROUTER), IKuruMarginAccount(KURU_MARGIN_ACCOUNT), IStataToken(WA_MON_USDT0))
        );
        // No USDT0 yield source other than Aave's USDT0 reserve, the protected pool: this vault keeps its capital idle.
        SelioVault vault =
            _deployVault(market, vaultName, vaultSymbol, IERC4626(address(0)), ISourceProbe(address(0)), leg);
        vm.serializeAddress(out, "priceRouter", address(prices));
        vm.serializeAddress(out, "market", address(market));
        vm.serializeAddress(out, "receipt", c.aToken);
        vm.serializeAddress(out, "underlying", market.underlying());
        vm.serializeAddress(out, "debtToken", c.debtToken);
        vm.serializeAddress(out, "aavePool", c.pool);
        vm.serializeAddress(out, "externalFlash", c.externalFlash);
        vm.serializeAddress(out, "payTokens", c.payTokens);
        vm.serializeAddress(out, "payATokens", c.payATokens);
        vm.serializeAddress(out, "collateralRoute", address(route));
        vm.serializeAddress(out, "selioVault", address(vault));
    }

    function _deployVault(
        ExitMarket market,
        string memory name,
        string memory symbol,
        IERC4626 yieldSource,
        ISourceProbe sourceProbe,
        SelioVault.KuruLeg memory kuruLeg
    ) internal returns (SelioVault) {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = VAULT_MIN_DISCOUNT_BPS;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = VAULT_MAX_SHARE_BPS;
        SelioVault.KuruLeg[] memory legs = new SelioVault.KuruLeg[](1);
        legs[0] = kuruLeg;
        return new SelioVault(
            name,
            symbol,
            IERC20(market.underlying()),
            markets,
            minD,
            maxShare,
            yieldSource,
            sourceProbe,
            legs,
            KURU_SHARE_BPS
        );
    }

    /* ------------------------------ Kuru ------------------------------ */

    /// @dev Creates (or reuses) the Kuru market of `market`'s receipt, or of `k.wrapper` when set, against the
    /// underlying, deploys its `KuruSellRouter` and serializes the Kuru keys. Returns the Selio Vault's Kuru leg;
    /// a disabled leg when `k.router` is zero.
    function _deployKuru(ExitMarket market, KuruConfig memory k) internal returns (SelioVault.KuruLeg memory leg) {
        if (address(k.router) == address(0)) return leg;
        address base = address(k.wrapper) != address(0) ? address(k.wrapper) : address(market.receipt());
        IKuruOrderBook book = _kuruMarket(k.router, base, market.underlying());
        KuruSellRouter sellRouter = new KuruSellRouter(market, book, k.wrapper);
        vm.serializeAddress(out, "kuruRouter", address(k.router));
        vm.serializeAddress(out, "kuruMarginAccount", address(k.margin));
        vm.serializeAddress(out, "kuruMarket", address(book));
        vm.serializeAddress(out, "kuruBase", base);
        vm.serializeAddress(out, "kuruWrapper", address(k.wrapper));
        vm.serializeAddress(out, "kuruSellRouter", address(sellRouter));
        leg = SelioVault.KuruLeg(book, k.margin, k.wrapper);
    }

    /// @dev The Kuru market of `base`/`quote` with Selio's parameters. Its address depends only on the parameters
    /// (CREATE2, no caller in the salt), so an existing one, created by anyone, is reused rather than created twice.
    function _kuruMarket(IKuruRouter router, address base, address quote) internal returns (IKuruOrderBook) {
        address predicted = router.computeAddress(
            base,
            quote,
            KURU_SIZE_PRECISION,
            KURU_PRICE_PRECISION,
            KURU_TICK_SIZE,
            KURU_MIN_SIZE,
            KURU_MAX_SIZE,
            KURU_TAKER_FEE_BPS,
            KURU_MAKER_FEE_BPS,
            KURU_AMM_SPREAD,
            address(0),
            false
        );
        if (router.verifiedMarket(predicted).pricePrecision == 0) {
            address created = router.deployProxy(
                0,
                base,
                quote,
                KURU_SIZE_PRECISION,
                KURU_PRICE_PRECISION,
                KURU_TICK_SIZE,
                KURU_MIN_SIZE,
                KURU_MAX_SIZE,
                KURU_TAKER_FEE_BPS,
                KURU_MAKER_FEE_BPS,
                KURU_AMM_SPREAD
            );
            require(created == predicted, "Kuru market not at its predicted address");
        }
        return IKuruOrderBook(predicted);
    }

    /* ----------------------------- Morpho ----------------------------- */

    function _deployMonadTestnet() internal {
        address usdc = vm.envOr("USDC_ADDRESS", CIRCLE_TESTNET_USDC);
        TestToken ausd = new TestToken("Simulated AUSD", "AUSD-sim", 18, 1_000_000 ether);
        FixedMorphoOracle oracle = new FixedMorphoOracle(1e24);
        Stack memory s = _buildMorphoStack(deployer, usdc, address(ausd), address(oracle), "Earn USDC (sim)", "eUSDC");
        address[] memory feeds = new address[](2);
        feeds[0] = address(new FixedPriceFeed(1e8, 8));
        feeds[1] = address(new FixedPriceFeed(1e8, 8));
        uint256[] memory maxAges = new uint256[](2);
        maxAges[0] = FRESH_FEED_MAX_AGE;
        maxAges[1] = FRESH_FEED_MAX_AGE;
        uint256[] memory minEscrows = new uint256[](2);
        minEscrows[0] = MIN_ESCROW_6DP;
        minEscrows[1] = MIN_ESCROW_18DP_USD;

        (IVaultV2 yieldVault,, MarketParams memory yieldMarket) =
            _buildYieldVault(s, deployer, "Yield USDC (sim)", "yUSDC");
        _seedYieldVault(s.morpho, yieldVault, yieldMarket, usdc, ausd);
        MorphoVaultSourceProbe probe = new MorphoVaultSourceProbe(yieldVault);

        // Kuru trades the Earn vault's shares themselves against USDC (Vault V2 shares need no wrapper).
        _deployMorphoMarket(
            s.morpho,
            s.vault,
            s.adapter,
            usdc,
            address(ausd),
            feeds,
            maxAges,
            minEscrows,
            IERC4626(address(yieldVault)),
            ISourceProbe(address(probe)),
            KuruConfig(
                IKuruRouter(KURU_TESTNET_ROUTER), IKuruMarginAccount(KURU_TESTNET_MARGIN_ACCOUNT), IStataToken(address(0))
            )
        );
        vm.serializeAddress(out, "morpho", address(s.morpho));
        vm.serializeAddress(out, "irm", s.irm);
        vm.serializeAddress(out, "collateral", address(ausd));
        vm.serializeAddress(out, "morphoOracle", address(oracle));
        vm.serializeBytes32(out, "earnMarketId", keccak256(abi.encode(s.earnMarket)));
        vm.serializeBytes32(out, "flashMarketId", keccak256(abi.encode(s.flashMarket)));
        vm.serializeBytes32(out, "yieldMarketId", keccak256(abi.encode(yieldMarket)));
    }

    /// @dev A borrower in the yield market so the yield vault earns interest. Skipped when the deployer holds too
    /// little of the loan token (for example anvil's default account on a fork of the testnet).
    function _seedYieldVault(IMorpho morpho, IVaultV2 yieldVault, MarketParams memory market, address usdc, TestToken ausd)
        internal
    {
        if (IERC20(usdc).balanceOf(deployer) < YIELD_SEED_DEPOSIT) {
            console.log("yield vault not seeded: deployer holds less than the seed deposit of the loan token");
            return;
        }
        IERC20(usdc).approve(address(yieldVault), YIELD_SEED_DEPOSIT);
        yieldVault.deposit(YIELD_SEED_DEPOSIT, deployer);
        ausd.mint(deployer, YIELD_SEED_COLLATERAL);
        ausd.approve(address(morpho), YIELD_SEED_COLLATERAL);
        morpho.supplyCollateral(market, YIELD_SEED_COLLATERAL, deployer, "");
        morpho.borrow(market, YIELD_SEED_BORROW, 0, deployer, deployer);
    }

    function _deployEarnFork() internal {
        address[] memory feeds = new address[](2);
        feeds[0] = USDC_USD_FEED;
        feeds[1] = ETH_USD_FEED;
        uint256[] memory maxAges = new uint256[](2);
        maxAges[0] = CHAINLINK_MAX_AGE;
        maxAges[1] = CHAINLINK_MAX_AGE;
        uint256[] memory minEscrows = new uint256[](2);
        minEscrows[0] = MIN_ESCROW_6DP;
        minEscrows[1] = MIN_ESCROW_WETH;
        // Base yield in Aave's static aToken for USDC, measured on Aave's USDC reserve.
        require(IERC4626(WA_MON_USDC).asset() == USDC, "waMonUSDC asset is not USDC");
        AaveSourceProbe probe = new AaveSourceProbe(IAavePool(AAVE_POOL), USDC, A_USDC);
        // No Kuru market on this network: the vault's Kuru leg is disabled.
        _deployMorphoMarket(
            IMorpho(MORPHO),
            IVaultV2(HYPERITHM_USDC_APEX),
            HYPERITHM_ADAPTER,
            USDC,
            WETH,
            feeds,
            maxAges,
            minEscrows,
            IERC4626(WA_MON_USDC),
            ISourceProbe(address(probe)),
            KuruConfig(IKuruRouter(address(0)), IKuruMarginAccount(address(0)), IStataToken(address(0)))
        );
        vm.serializeAddress(out, "morpho", MORPHO);
        vm.serializeAddress(out, "collateral", WETH);
    }

    function _deployMorphoMarket(
        IMorpho morpho,
        IVaultV2 earn,
        address adapter,
        address usdc,
        address collateral,
        address[] memory feeds,
        uint256[] memory maxAges,
        uint256[] memory minEscrows,
        IERC4626 yieldSource,
        ISourceProbe sourceProbe,
        KuruConfig memory kuru
    ) internal {
        address[] memory tokens = new address[](2);
        tokens[0] = usdc;
        tokens[1] = collateral;
        PriceRouter prices = new PriceRouter(tokens, feeds, maxAges);
        MorphoVaultExitMarket market =
            new MorphoVaultExitMarket(morpho, earn, adapter, prices, tokens, minEscrows, deployer);
        SelioVault.KuruLeg memory leg = _deployKuru(market, kuru);
        SelioVault vault = _deployVault(market, "Selio Vault USDC", "slUSDC", yieldSource, sourceProbe, leg);
        vm.serializeAddress(out, "priceRouter", address(prices));
        vm.serializeAddress(out, "market", address(market));
        vm.serializeAddress(out, "receipt", address(earn));
        vm.serializeAddress(out, "underlying", usdc);
        vm.serializeAddress(out, "earnVault", address(earn));
        vm.serializeAddress(out, "adapter", adapter);
        vm.serializeAddress(out, "payTokens", tokens);
        vm.serializeAddress(out, "selioVault", address(vault));
        vm.serializeAddress(out, "yieldSource", address(yieldSource));
        vm.serializeAddress(out, "sourceProbe", address(sourceProbe));
    }

    function _addresses4(address a, address b, address c, address d) internal pure returns (address[] memory r) {
        r = new address[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _uints4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory r) {
        r = new uint256[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }
}
