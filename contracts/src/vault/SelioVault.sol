// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ExitMarket} from "../market/ExitMarket.sol";
import {ISourceProbe} from "../shared/interfaces/ISourceProbe.sol";
import {IKuruOrderBook, IKuruMarginAccount, KuruMarketParams} from "../shared/interfaces/IKuru.sol";
import {IStataToken} from "../shared/interfaces/IStataToken.sol";
import {KuruMath} from "../kuru/KuruMath.sol";

/// @title SelioVault
/// @notice Pooled buyer of last resort. Depositors' idle capital stays outside the protected pool and is escrowed as
/// limit bids on exit markets of the same denomination. Bought receipts are held until the pool is liquid again;
/// anyone can trigger their redemption. Depositors exit at any time, receiving idle capital in the vault asset and
/// their share of held receipts in kind.
/// @notice Receipts bought through the vault's own bids are valued at their cost until they are recovered; receipts
/// sent to the vault directly are not counted.
/// @notice Capital beyond bid escrow earns base yield in an optional ERC-4626 yield source while that source's pool
/// is below 90% utilization; anyone can pull it back to cash at or above 90%, and a redemption pays any part the
/// source cannot pay now in kind, as source shares. The vault never takes a flash loan.
/// @notice A strategy can also quote a standing bid on the Kuru order book of its receipt (or of the receipt's static
/// wrapper), using a fixed share of its room under the cap. Every operation re-prices it at the minimum discount, and
/// its fills join the vault's books at cost. While Kuru is unreachable, operations still succeed and a redeemer's
/// share of the Kuru position becomes a claim paid once Kuru is reachable again.
/// @dev Rules are fixed at deployment: per market, a minimum discount and a maximum share of vault capital. There is
/// no owner, no fee and no admin function.
contract SelioVault is ERC20, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    struct Strategy {
        ExitMarket market;
        IERC20 receipt;
        uint16 minDiscountBps;
        uint16 maxShareBps;
        uint8 payIdx;
    }

    /// @dev Tracked receipt units and their cost that have left the vault's books.
    struct Released {
        uint256 units;
        uint256 cost;
    }

    /// @notice Kuru leg of a strategy (`book == address(0)` disables it): the order book trading the strategy's
    /// receipt, or `wrapper` (Aave's static aToken of that receipt) when set, against the vault asset.
    struct KuruLeg {
        IKuruOrderBook book;
        IKuruMarginAccount margin;
        IStataToken wrapper;
    }

    struct KuruState {
        IKuruOrderBook book; // 0 = no Kuru leg for this strategy
        IKuruMarginAccount margin;
        IStataToken wrapper; // waMonUSDT0 on usdt0-replay, 0 on Morpho
        uint40 orderId; // live order, 0 = none
        uint32 price; // price of that order (pricePrecision units)
        uint96 placedSize; // size left resting right after placement (sizePrecision units)
        uint256 escrow; // quote the placement actually debited (measured)
        uint256 baseAtPlace; // base credited to the vault's margin account by crossing fills at placement (measured)
    }

    /// @dev The fraction of a Kuru leg that redeemers claimed while it was unreachable, and what was set aside for
    /// them when it resolved: `cash` in the vault asset and `units` receipt tokens of the strategy.
    struct Epoch {
        uint256 claimedWad;
        bool resolved;
        uint256 cash;
        uint256 units;
        uint256 paidCash;
        uint256 paidUnits;
        uint256 paidWad;
    }

    struct Claim {
        uint64 epoch;
        uint256 wad;
    }

    /// @dev Kuru order and refreshed Selio bid of one strategy, as sized by `_refreshBids`.
    struct Sizing {
        uint256 room;
        uint256 avail;
        uint256 selioRoom;
        uint256 want;
        uint32 kuruPrice;
        uint96 kuruSize;
        uint256 kuruDebit;
    }

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;
    uint8 internal constant DECIMALS_OFFSET = 3;
    uint256 internal constant VIRTUAL_SHARES = 10 ** DECIMALS_OFFSET;
    uint256 public constant MAX_STRATEGIES = 8;
    /// @notice Source utilization at or above which the vault stops depositing and anyone can pull the source back.
    uint256 public constant SOURCE_MAX_UTILIZATION_BPS = 9_000;

    IERC20 public immutable asset;
    uint8 internal immutable assetDecimals;
    /// @notice ERC-4626 vault of `asset` that earns base yield on capital beyond bid escrow; `address(0)` for none.
    IERC4626 public immutable yieldSource;
    /// @notice Liquidity of the pool behind `yieldSource`; `address(0)` for none.
    ISourceProbe public immutable sourceProbe;
    /// @notice Share of a strategy's room under the cap that its Kuru bid may use, in basis points.
    uint16 public immutable kuruShareBps;

    Strategy[] internal strategies_;
    /// @notice Active bid of the vault on each strategy's market (0 when none).
    uint256[] public bidOf;
    Released[] internal released_;
    /// @notice Receipt tokens of strategy `i` that a redemption of `owner`'s shares set aside for `owner`.
    mapping(address => mapping(uint256 => uint256)) public claimable;
    uint256[] public totalClaimable;
    /// @notice Source shares the vault minted itself; shares sent to the vault directly are not counted.
    uint256 public sourceShares;
    KuruState[] internal kuru_;
    /// @dev Kuru fills booked per strategy: receipt units received and quote paid; never reduced.
    ExitMarket.Fill[] internal kuruFills_;
    mapping(uint256 => uint64) internal kuruEpoch_;
    mapping(uint256 => mapping(uint64 => Epoch)) internal kuruEpochs_;
    mapping(address => mapping(uint256 => Claim)) internal kuruClaims_;
    /// @dev Vault asset set aside for resolved Kuru claims; not part of the vault's capital.
    uint256 internal kuruCashSetAside_;
    /// @dev Receipt tokens of each strategy set aside for resolved Kuru claims; not part of the receipt pool.
    mapping(uint256 => uint256) internal kuruUnitsSetAside_;

    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
    event Redeem(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 shares,
        uint256 assets,
        uint256[] receipts
    );
    event Recovered(uint256 indexed strategy, address indexed caller, uint256 assets);
    event BidsRefreshed(uint256 totalAssets, uint256 idle);
    event ReceiptDeferred(address indexed owner, uint256 indexed strategy, uint256 amount);
    event ReceiptClaimed(address indexed owner, address indexed receiver, uint256 indexed strategy, uint256 amount);
    event SourceDeposited(uint256 assets, uint256 shares);
    event SourceWithdrawn(uint256 assets, uint256 shares);
    event SourcePulled(uint256 assets, uint256 shares, uint256 utilizationBps);
    event SourceSharesInKind(address indexed receiver, uint256 shares);
    event KuruOrderPlaced(uint256 indexed i, uint40 orderId, uint32 price, uint96 size, uint256 escrow);
    event KuruSynced(uint256 indexed i, uint256 units, uint256 paid, uint256 refund, uint256 untrackedBase);
    event KuruUnavailable(uint256 indexed i, bytes reason);
    event KuruClaimDeferred(address indexed owner, uint256 indexed i, uint64 epoch, uint256 wad);
    event KuruClaimPaid(address indexed owner, uint256 indexed i, address receiver, uint256 cash, uint256 receipts);

    error BadParams();
    error ZeroAmount();
    error ZeroShares();
    error InsufficientShares(uint256 shares, uint256 minShares);
    error SourceNotTight();
    error NotSelf();
    error NothingToClaim();

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 asset_,
        ExitMarket[] memory markets,
        uint16[] memory minDiscountBps,
        uint16[] memory maxShareBps,
        IERC4626 yieldSource_,
        ISourceProbe sourceProbe_,
        KuruLeg[] memory kuru,
        uint16 kuruShareBps_
    ) ERC20(name_, symbol_) {
        uint256 n = markets.length;
        if (n == 0 || n > MAX_STRATEGIES || minDiscountBps.length != n || maxShareBps.length != n) revert BadParams();
        if (kuru.length != n || kuruShareBps_ > BPS) revert BadParams();
        asset = asset_;
        assetDecimals = IERC20Metadata(address(asset_)).decimals();
        for (uint256 i; i < n; ++i) {
            ExitMarket m = markets[i];
            // Same denomination only.
            if (m.underlying() != address(asset_)) revert BadParams();
            if (maxShareBps[i] == 0 || maxShareBps[i] > BPS || minDiscountBps[i] > m.MAX_DISCOUNT_BPS()) {
                revert BadParams();
            }
            IERC20 r = m.receipt();
            for (uint256 j; j < i; ++j) {
                if (strategies_[j].receipt == r) revert BadParams();
            }
            strategies_.push(
                Strategy({
                    market: m,
                    receipt: r,
                    minDiscountBps: minDiscountBps[i],
                    maxShareBps: maxShareBps[i],
                    payIdx: _payIndex(m, address(asset_))
                })
            );
            bidOf.push(0);
            released_.push();
            totalClaimable.push(0);
            asset_.forceApprove(address(m), type(uint256).max);
            r.forceApprove(address(m), type(uint256).max);
            KuruLeg memory k = kuru[i];
            if (address(k.book) != address(0)) {
                // The book trades this strategy's receipt (or its static wrapper) against the vault asset.
                KuruMarketParams memory p = k.book.getMarketParams();
                address base = address(k.wrapper) != address(0) ? address(k.wrapper) : address(r);
                if (p.quote != address(asset_) || p.base != base || address(k.margin) == address(0)) revert BadParams();
                if (address(k.wrapper) != address(0) && k.wrapper.aToken() != address(r)) revert BadParams();
                asset_.forceApprove(address(k.margin), type(uint256).max);
            }
            kuru_.push(
                KuruState({
                    book: k.book,
                    margin: k.margin,
                    wrapper: k.wrapper,
                    orderId: 0,
                    price: 0,
                    placedSize: 0,
                    escrow: 0,
                    baseAtPlace: 0
                })
            );
            kuruFills_.push();
        }
        kuruShareBps = kuruShareBps_;
        if ((address(yieldSource_) == address(0)) != (address(sourceProbe_) == address(0))) revert BadParams();
        if (address(yieldSource_) != address(0)) {
            if (yieldSource_.asset() != address(asset_)) revert BadParams();
            // The source must not be a protected pool: neither a strategy's receipt nor measured by its pool.
            address measured = sourceProbe_.receipt();
            for (uint256 i; i < n; ++i) {
                address r = address(strategies_[i].receipt);
                if (address(yieldSource_) == r || measured == r) revert BadParams();
            }
            asset_.forceApprove(address(yieldSource_), type(uint256).max);
        }
        yieldSource = yieldSource_;
        sourceProbe = sourceProbe_;
    }

    /* -------------------------------------------------------------------------- */
    /*                                    Views                                   */
    /* -------------------------------------------------------------------------- */

    function decimals() public view override returns (uint8) {
        return assetDecimals + DECIMALS_OFFSET;
    }

    function strategiesLength() external view returns (uint256) {
        return strategies_.length;
    }

    function strategy(uint256 i) external view returns (Strategy memory) {
        return strategies_[i];
    }

    /// @notice Vault asset held directly, the escrow of the vault's live bids, and the cash of its Kuru legs (what
    /// cancelling each Kuru order would return, plus quote credited to the vault's Kuru margin account).
    function idleAssets() public view returns (uint256 idle) {
        idle = _cash();
        for (uint256 i; i < strategies_.length; ++i) {
            idle += _escrowOf(i) + _kuruCash(i);
        }
    }

    /// @notice Receipt units of strategy `i` bought through the vault's own bids (on its market and on Kuru) and still
    /// held for its depositors.
    function heldUnits(uint256 i) public view returns (uint256) {
        (uint256 units,) = strategies_[i].market.fillsOf(address(this), address(asset));
        return units + kuruFills_[i].units - released_[i].units;
    }

    /// @notice Escrow spent on the units of `heldUnits(i)`, plus the cost of Kuru fills not yet synced.
    function heldCost(uint256 i) public view returns (uint256) {
        (,,, uint256 pendingCost) = kuruOrderState(i);
        return _trackedCost(i) + _unclaimed(i, pendingCost);
    }

    /// @notice Stored Kuru leg of strategy `i`.
    function kuruLeg(uint256 i)
        external
        view
        returns (
            address book,
            address margin,
            address wrapper,
            uint40 orderId,
            uint32 price,
            uint96 placedSize,
            uint256 escrow,
            uint256 baseAtPlace
        )
    {
        KuruState storage k = kuru_[i];
        return (
            address(k.book),
            address(k.margin),
            address(k.wrapper),
            k.orderId,
            k.price,
            k.placedSize,
            k.escrow,
            k.baseAtPlace
        );
    }

    /// @notice State of the vault's Kuru order on strategy `i`: whether it still rests, its remaining size, the quote
    /// a cancel would return, and the cost of what it bought since placement.
    function kuruOrderState(uint256 i)
        public
        view
        returns (bool active, uint96 remainingSize, uint256 refundValue, uint256 pendingCost)
    {
        KuruState storage k = kuru_[i];
        uint256 escrow = k.escrow;
        if (escrow == 0) return (false, 0, 0, 0);
        (active, remainingSize) = _kuruOrderStatus(k.book, k.orderId);
        if (active) refundValue = KuruMath.refundValue(remainingSize, k.price, k.book.getMarketParams());
        pendingCost = escrow > refundValue ? escrow - refundValue : 0;
    }

    /// @notice Kuru fills booked on strategy `i`: receipt units received and quote paid.
    function kuruFills(uint256 i) external view returns (uint256 units, uint256 paid) {
        ExitMarket.Fill storage f = kuruFills_[i];
        return (f.units, f.paid);
    }

    /// @notice `owner`'s claim on strategy `i`'s Kuru leg: its epoch and the claimed fraction of the leg (WAD).
    function kuruClaimOf(address owner, uint256 i) external view returns (uint64 epoch, uint256 wad) {
        Claim storage c = kuruClaims_[owner][i];
        return (c.epoch, c.wad);
    }

    /// @notice Face value of the tracked receipts of strategy `i` (used by `recover`, not by share pricing).
    function heldAssets(uint256 i) public view returns (uint256) {
        Strategy storage s = strategies_[i];
        uint256 face = s.market.unitsToAssets(heldUnits(i));
        uint256 pooled = s.market.receiptValue(_poolReceipts(i));
        return face < pooled ? face : pooled;
    }

    /// @notice Idle capital, tracked receipts at cost and the value of the vault's own source shares.
    function totalAssets() public view returns (uint256 total) {
        total = idleAssets() + sourceAssets();
        for (uint256 i; i < strategies_.length; ++i) {
            total += heldCost(i);
        }
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, totalAssets() + 1);
    }

    /// @notice What redeeming `shares` pays now: `assets` in the vault asset (idle capital plus the source part the
    /// source can pay), `receipts[i]` of each strategy's receipt in kind, and `sourceInKind` source shares in kind.
    function previewRedeem(uint256 shares)
        public
        view
        returns (uint256 assets, uint256[] memory receipts, uint256 sourceInKind)
    {
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        assets = Math.mulDiv(idleAssets(), shares, denom);
        uint256 n = strategies_.length;
        receipts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            receipts[i] = Math.mulDiv(_poolReceipts(i), shares, denom);
        }
        uint256 srcShares = Math.mulDiv(sourceShares, shares, denom);
        if (srcShares > 0) {
            uint256 cashShares = _payableSourceShares(srcShares);
            if (cashShares > 0) assets += yieldSource.previewRedeem(cashShares);
            sourceInKind = srcShares - cashShares;
        }
    }

    /// @notice Value of the vault's own source shares.
    function sourceAssets() public view returns (uint256) {
        return sourceShares == 0 ? 0 : yieldSource.convertToAssets(sourceShares);
    }

    /// @notice Utilization of the pool behind the yield source, in basis points, rounded down; 0 without a source.
    function sourceUtilizationBps() public view returns (uint256) {
        if (address(sourceProbe) == address(0)) return 0;
        (uint256 withdrawable, uint256 supplied) = sourceProbe.liquidity();
        return supplied == 0 || withdrawable >= supplied ? 0 : (supplied - withdrawable) * BPS / supplied;
    }

    /* -------------------------------------------------------------------------- */
    /*                              Depositor actions                             */
    /* -------------------------------------------------------------------------- */

    function deposit(uint256 assets, address receiver, uint256 minShares)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        bool[] memory reachable = _syncKuru();
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert InsufficientShares(shares, minShares);
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _refreshBids(0, reachable);
    }

    /// @notice Redeems `shares` of `owner` for idle capital now and the matching share of held receipts in kind.
    /// Strategies listed in `skip` have their receipts set aside for `owner` (see `claim`) instead of transferred.
    /// The share of a Kuru leg that cannot be reached now becomes `owner`'s claim on that leg (see `claimKuru`).
    function redeem(uint256 shares, address receiver, address owner, uint256[] calldata skip)
        external
        nonReentrant
        returns (uint256 assets, uint256[] memory receipts, uint256 sourceInKind)
    {
        if (shares == 0) revert ZeroShares();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        uint256 n = strategies_.length;
        for (uint256 k; k < skip.length; ++k) {
            if (skip[k] >= n) revert BadParams();
        }
        bool[] memory reachable = _syncKuru();
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        uint256 idle = idleAssets();
        receipts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            receipts[i] = Math.mulDiv(_poolReceipts(i), shares, denom);
            _release(i, Math.mulDiv(heldUnits(i), shares, denom), Math.mulDiv(_trackedCost(i), shares, denom));
            if (!reachable[i]) {
                // Cash still in an unreachable Kuru leg is not paid now: the redeemer's share becomes a claim.
                idle -= _kuruCash(i);
                _deferKuruClaim(owner, i, shares, denom);
            }
        }
        assets = Math.mulDiv(idle, shares, denom);
        uint256 srcShares = Math.mulDiv(sourceShares, shares, denom);
        _burn(owner, shares);
        for (uint256 k; k < skip.length; ++k) {
            uint256 i = skip[k];
            uint256 amount = receipts[i];
            if (amount == 0) continue;
            claimable[owner][i] += amount;
            totalClaimable[i] += amount;
            receipts[i] = 0;
            emit ReceiptDeferred(owner, i, amount);
        }
        if (srcShares > 0) {
            uint256 cash;
            (cash, sourceInKind) = _redeemSourceShare(srcShares);
            assets += cash;
        }
        _refreshBids(assets, reachable);
        if (assets > 0) asset.safeTransfer(receiver, assets);
        for (uint256 i; i < n; ++i) {
            if (receipts[i] > 0) strategies_[i].receipt.safeTransfer(receiver, receipts[i]);
        }
        if (sourceInKind > 0) {
            IERC20(address(yieldSource)).safeTransfer(receiver, sourceInKind);
            emit SourceSharesInKind(receiver, sourceInKind);
        }
        emit Redeem(msg.sender, receiver, owner, shares, assets, receipts);
    }

    /// @notice Sends the caller's set-aside receipts of strategy `i` to `receiver`.
    function claim(uint256 i, address receiver) external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender][i];
        if (amount == 0) revert ZeroAmount();
        claimable[msg.sender][i] = 0;
        totalClaimable[i] -= amount;
        strategies_[i].receipt.safeTransfer(receiver, amount);
        emit ReceiptClaimed(msg.sender, receiver, i, amount);
    }

    /// @notice Pays the caller's claim on strategy `i`'s Kuru leg, deferred by a redemption while the leg was
    /// unreachable and resolved since: its share of the cash and receipts the leg held then.
    function claimKuru(uint256 i, address receiver) external nonReentrant returns (uint256 cash, uint256 receipts) {
        return _payKuruClaim(msg.sender, i, receiver);
    }

    /* -------------------------------------------------------------------------- */
    /*                            Permissionless upkeep                           */
    /* -------------------------------------------------------------------------- */

    /// @notice Redeems up to `assets` of the tracked receipts of strategy `i` now that its pool is liquid.
    function recover(uint256 i, uint256 assets) external nonReentrant returns (uint256 redeemed) {
        bool[] memory reachable = _syncKuru();
        uint256 held = heldAssets(i);
        if (assets > held) assets = held;
        if (assets == 0) revert ZeroAmount();
        ExitMarket market = strategies_[i].market;
        uint256 u0 = market.unitsOf(address(this));
        redeemed = market.redeemReceipt(assets, address(this));
        uint256 out = u0 - market.unitsOf(address(this));
        uint256 units = heldUnits(i);
        uint256 cost = _trackedCost(i);
        uint256 du = out < units ? out : units;
        if (du == units || _poolReceipts(i) == 0) _release(i, units, cost);
        else _release(i, du, Math.mulDiv(cost, du, units));
        emit Recovered(i, msg.sender, redeemed);
        _refreshBids(0, reachable);
    }

    /// @notice Books the vault's Kuru fills and resizes and re-prices its bids to its current capital.
    function refreshBids() external nonReentrant {
        _refreshBids(0, _syncKuru());
    }

    /// @notice One Kuru step of the vault, callable only by the vault itself so that each step can run under
    /// `try`: `op` 0 books strategy `i`'s Kuru fills and cancels its order, 1 places an order of size `b` at price `a`.
    function kuruOp(uint8 op, uint256 i, uint256 a, uint256 b) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (op == 0) _kuruSync(i);
        else _kuruPlace(i, uint32(a), uint96(b));
    }

    /// @notice Pulls capital back from the yield source once its pool reaches 90% utilization: redeems as many of
    /// the vault's source shares as the source can pay now and keeps the assets in the vault.
    function pullFromSource() external nonReentrant returns (uint256 assets, uint256 shares) {
        uint256 utilizationBps = sourceUtilizationBps();
        if (utilizationBps < SOURCE_MAX_UTILIZATION_BPS) revert SourceNotTight();
        shares = _payableSourceShares(sourceShares);
        if (shares > 0) {
            uint256 before = asset.balanceOf(address(this));
            yieldSource.redeem(shares, address(this), address(this));
            assets = asset.balanceOf(address(this)) - before;
            sourceShares -= shares;
        }
        emit SourcePulled(assets, shares, utilizationBps);
    }

    /* -------------------------------------------------------------------------- */
    /*                                  Internals                                 */
    /* -------------------------------------------------------------------------- */

    function _payIndex(ExitMarket m, address token) internal view returns (uint8) {
        address[] memory tokens = m.payTokens();
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == token) return uint8(i);
        }
        revert BadParams();
    }

    function _escrowOf(uint256 i) internal view returns (uint256) {
        uint256 id = bidOf[i];
        if (id == 0) return 0;
        (address bidder,,,, uint256 escrow) = strategies_[i].market.bids(id);
        return bidder == address(this) ? escrow : 0;
    }

    /// @dev Receipt balance of strategy `i` minus the receipts set aside for holders and for Kuru claims.
    function _poolReceipts(uint256 i) internal view returns (uint256) {
        uint256 balance = strategies_[i].receipt.balanceOf(address(this));
        uint256 setAside = totalClaimable[i] + kuruUnitsSetAside_[i];
        return balance > setAside ? balance - setAside : 0;
    }

    function _release(uint256 i, uint256 units, uint256 cost) internal {
        Released storage r = released_[i];
        r.units += units;
        r.cost += cost;
    }

    /// @dev Cost of the receipts on the vault's books (Selio and synced Kuru fills), without unsynced Kuru fills.
    function _trackedCost(uint256 i) internal view returns (uint256) {
        (, uint256 paid) = strategies_[i].market.fillsOf(address(this), address(asset));
        return paid + kuruFills_[i].paid - released_[i].cost;
    }

    /// @dev Vault asset held directly, minus the cash set aside for resolved Kuru claims.
    function _cash() internal view returns (uint256) {
        uint256 balance = asset.balanceOf(address(this));
        return balance > kuruCashSetAside_ ? balance - kuruCashSetAside_ : 0;
    }

    /// @dev Sizes every strategy's Kuru order and bid for the capital left after paying out `reserve`, then applies
    /// the sizes: shrinks and closes Selio bids first so their refunds fund the rest, takes any shortfall from the
    /// yield source, places the Kuru orders (a failed placement hands its share back to the Selio bid), then grows
    /// and places Selio bids in place; cash beyond escrow and `reserve` then goes to the source. `reachable[i]` is
    /// false for a Kuru leg whose sync failed in this operation: its cash cannot be spent and it gets no new order.
    function _refreshBids(uint256 reserve, bool[] memory reachable) internal {
        uint256 total = totalAssets() - reserve;
        uint256 budget = idleAssets() + _sourceLiquid() - reserve;
        uint256 n = strategies_.length;
        for (uint256 i; i < n; ++i) {
            if (!reachable[i]) budget -= _kuruCash(i);
        }
        Sizing[] memory z = new Sizing[](n);
        for (uint256 i; i < n; ++i) {
            z[i] = _size(i, total, budget, reachable[i]);
            budget -= z[i].kuruDebit + z[i].want;
        }
        uint256 needed = reserve;
        for (uint256 i; i < n; ++i) {
            uint256 escrow = _liveEscrow(i);
            if (z[i].want <= escrow) _applyBid(i, z[i].selioRoom, z[i].want);
            else needed += z[i].want - escrow;
            needed += z[i].kuruDebit;
        }
        _fundFromSource(needed);
        for (uint256 i; i < n; ++i) {
            bool kuruFailed;
            if (z[i].kuruSize > 0) {
                try this.kuruOp(1, i, z[i].kuruPrice, z[i].kuruSize) {}
                catch (bytes memory reason) {
                    emit KuruUnavailable(i, reason);
                    z[i].selioRoom = z[i].room;
                    z[i].want = _minEscrowRule(i, z[i].want + z[i].kuruDebit);
                    kuruFailed = true;
                }
            }
            if (kuruFailed || z[i].want > _escrowOf(i)) _applyBid(i, z[i].selioRoom, z[i].want);
        }
        _depositToSource(reserve);
        emit BidsRefreshed(total, idleAssets() - reserve);
    }

    /// @dev Room under strategy `i`'s cap (on holdings at cost), its Kuru order (`kuruShareBps` of the room, within
    /// `budget`) and the escrow and `maxAssets` of its Selio bid, which takes the rest of the room.
    function _size(uint256 i, uint256 total, uint256 budget, bool reachable) internal view returns (Sizing memory z) {
        uint256 cap = Math.mulDiv(total, strategies_[i].maxShareBps, BPS);
        uint256 held = heldCost(i);
        uint256 room = cap > held ? cap - held : 0;
        if (address(kuru_[i].book) != address(0)) {
            if (reachable) {
                uint256 kuruRoom = Math.mulDiv(room, kuruShareBps, BPS);
                (z.kuruPrice, z.kuruSize, z.kuruDebit) = _kuruSize(i, budget < kuruRoom ? budget : kuruRoom, kuruRoom);
            } else {
                // The unreachable leg's resting order can still be filled when Kuru resumes.
                (,, uint256 refund,) = kuruOrderState(i);
                room = room > refund ? room - refund : 0;
            }
        }
        z.room = room;
        z.selioRoom = room > z.kuruDebit ? room - z.kuruDebit : 0;
        uint256 rest = budget - z.kuruDebit;
        z.want = _minEscrowRule(i, rest < z.selioRoom ? rest : z.selioRoom);
    }

    /// @dev `want`, or 0 when it is below the market's minimum escrow for the vault asset.
    function _minEscrowRule(uint256 i, uint256 want) internal view returns (uint256) {
        uint256 minEscrow = strategies_[i].market.minEscrowOf(address(asset));
        return want < (minEscrow > 1 ? minEscrow : 1) ? 0 : want;
    }

    /// @dev Escrow of the vault's live bid on strategy `i`; forgets a bid the market has closed.
    function _liveEscrow(uint256 i) internal returns (uint256 escrow) {
        uint256 id = bidOf[i];
        if (id == 0) return 0;
        address bidder;
        (bidder,,,, escrow) = strategies_[i].market.bids(id);
        if (bidder != address(this)) {
            bidOf[i] = 0;
            escrow = 0;
        }
    }

    /// @dev Gives strategy `i`'s bid `maxAssets = room` and `escrow = want`, keeping its id; places a bid when there is
    /// none and cancels it when `want` is 0.
    function _applyBid(uint256 i, uint256 room, uint256 want) internal {
        Strategy storage s = strategies_[i];
        uint256 id = bidOf[i];
        if (id != 0) {
            if (want == 0) {
                s.market.cancelBid(id);
                bidOf[i] = 0;
            } else {
                (,,, uint256 maxAssets, uint256 escrow) = s.market.bids(id);
                if (maxAssets != room || escrow != want) s.market.resizeBid(id, room, want);
            }
        } else if (want > 0) {
            bidOf[i] = s.market.placeBid(s.minDiscountBps, s.payIdx, room, want);
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                                  Kuru leg                                  */
    /* -------------------------------------------------------------------------- */

    /// @dev Syncs every Kuru leg under `try`; `reachable[i]` is false only for a leg whose sync failed.
    function _syncKuru() internal returns (bool[] memory reachable) {
        uint256 n = strategies_.length;
        reachable = new bool[](n);
        for (uint256 i; i < n; ++i) {
            reachable[i] = true;
            if (address(kuru_[i].book) == address(0)) continue;
            try this.kuruOp(0, i, 0, 0) {}
            catch (bytes memory reason) {
                reachable[i] = false;
                emit KuruUnavailable(i, reason);
            }
        }
    }

    /// @dev Books strategy `i`'s Kuru fills at cost (escrow minus what cancelling the order returned), unwraps the
    /// bought base into the strategy's receipt and withdraws all quote. Base beyond what the vault's own orders could
    /// have bought was credited by someone else and stays untracked. Resolves an open claim epoch.
    function _kuruSync(uint256 i) internal {
        KuruState storage k = kuru_[i];
        IKuruOrderBook book = k.book;
        IKuruMarginAccount margin = k.margin;
        KuruMarketParams memory p = book.getMarketParams();
        (bool active, uint96 remaining) = _kuruOrderStatus(book, k.orderId);
        uint256 expectedBase = k.baseAtPlace + KuruMath.baseAmount(k.placedSize - remaining, p);
        uint256 q0 = margin.getBalance(address(this), address(asset));
        if (active) {
            // Only a resting order is cancelled: Kuru reverts on an id that was already cancelled.
            uint40[] memory ids = new uint40[](1);
            ids[0] = k.orderId;
            book.batchCancelOrdersNoRevert(ids);
        }
        uint256 refund = margin.getBalance(address(this), address(asset)) - q0;
        uint256 paid = k.escrow > refund ? k.escrow - refund : 0;
        uint256 bal = margin.getBalance(address(this), p.base);
        uint256 tracked = bal < expectedBase ? bal : expectedBase;
        uint256 du;
        uint256 dr;
        if (bal > 0) {
            ExitMarket market = strategies_[i].market;
            IERC20 receipt = strategies_[i].receipt;
            uint256 u0 = market.unitsOf(address(this));
            uint256 r0 = receipt.balanceOf(address(this));
            margin.withdraw(bal, p.base);
            if (address(k.wrapper) != address(0)) k.wrapper.redeemATokens(bal, address(this), address(this));
            du = Math.mulDiv(market.unitsOf(address(this)) - u0, tracked, bal);
            dr = Math.mulDiv(receipt.balanceOf(address(this)) - r0, tracked, bal);
        }
        ExitMarket.Fill storage f = kuruFills_[i];
        f.units += du;
        f.paid += paid;
        if (refund + q0 > 0) margin.withdraw(refund + q0, address(asset));
        k.orderId = 0;
        k.price = 0;
        k.placedSize = 0;
        k.escrow = 0;
        k.baseAtPlace = 0;
        _resolveKuruEpoch(i, refund, du, dr, paid);
        emit KuruSynced(i, du, paid, refund, bal - tracked);
    }

    /// @dev Places the vault's Kuru bid (not post-only: an ask below its price is bought at that ask) and records what
    /// the placement debited, what crossing bought at once and the order that rests, if any.
    function _kuruPlace(uint256 i, uint32 price, uint96 size) internal {
        KuruState storage k = kuru_[i];
        IKuruOrderBook book = k.book;
        IKuruMarginAccount margin = k.margin;
        KuruMarketParams memory p = book.getMarketParams();
        uint256 d = KuruMath.debit(price, size, p);
        margin.deposit(address(this), address(asset), d);
        uint256 b0 = margin.getBalance(address(this), p.base);
        uint40 c0 = book.s_orderIdCounter();
        book.addBuyOrder(price, size, false);
        uint256 r0 = margin.getBalance(address(this), address(asset));
        if (r0 > 0) margin.withdraw(r0, address(asset));
        k.escrow = d - r0;
        k.baseAtPlace = margin.getBalance(address(this), p.base) - b0;
        k.price = price;
        // The order rests under a new id unless crossing filled it in full; matching may create other orders first.
        for (uint40 id = book.s_orderIdCounter(); id > c0; --id) {
            (address owner, uint96 rest,,,,,,) = book.s_orders(id);
            if (owner == address(this)) {
                k.orderId = id;
                k.placedSize = rest;
                break;
            }
        }
        emit KuruOrderPlaced(i, k.orderId, price, size, k.escrow);
    }

    /// @dev Kuru price and size of strategy `i`'s order within `budget` and `room`, and the quote it debits; zero when
    /// the order would be below the market's minimum size.
    function _kuruSize(uint256 i, uint256 budget, uint256 room) internal view returns (uint32, uint96, uint256) {
        KuruState storage k = kuru_[i];
        KuruMarketParams memory p = k.book.getMarketParams();
        uint256 face = KuruMath.facePerBase(strategies_[i].market, k.wrapper, p.baseDecimals);
        uint256 price = KuruMath.vaultPrice(face, strategies_[i].minDiscountBps, p);
        if (price == 0 || price > type(uint32).max) return (0, 0, 0);
        uint256 size = KuruMath.sizeFor(price, face, budget, room, p);
        if (size < p.minSize) return (0, 0, 0);
        return (uint32(price), uint96(size), KuruMath.debit(price, size, p));
    }

    /// @dev Whether order `id` still rests on `book` and its remaining size. A cancelled order's record is deleted; a
    /// filled one keeps its record, but its price point's FIFO head has moved past it.
    function _kuruOrderStatus(IKuruOrderBook book, uint40 id) internal view returns (bool active, uint96 remaining) {
        if (id == 0) return (false, 0);
        (, uint96 size,,,, uint32 price,,) = book.s_orders(id);
        if (price == 0) return (false, 0);
        (uint40 head,) = book.s_buyPricePoints(price);
        if (head == 0 || head > id) return (false, 0);
        return (true, size);
    }

    /// @dev The vault's share of strategy `i`'s Kuru cash: the refund value of its resting order plus quote in its
    /// margin account (counted on the first leg using that account).
    function _kuruCash(uint256 i) internal view returns (uint256) {
        KuruState storage k = kuru_[i];
        if (address(k.book) == address(0)) return 0;
        (,, uint256 refund,) = kuruOrderState(i);
        for (uint256 j; j < i; ++j) {
            if (address(kuru_[j].book) != address(0) && kuru_[j].margin == k.margin) return _unclaimed(i, refund);
        }
        return _unclaimed(i, refund + k.margin.getBalance(address(this), address(asset)));
    }

    /// @dev The part of `amount` of strategy `i`'s Kuru leg that is still the vault's, net of the open epoch's claims.
    function _unclaimed(uint256 i, uint256 amount) internal view returns (uint256) {
        uint256 claimed = kuruEpochs_[i][kuruEpoch_[i]].claimedWad;
        return claimed == 0 ? amount : Math.mulDiv(amount, WAD - claimed, WAD);
    }

    /// @dev Records `owner`'s claim on unreachable leg `i` for redeeming `shares` of `denom`; first pays an older,
    /// resolved claim of `owner` on that leg.
    function _deferKuruClaim(address owner, uint256 i, uint256 shares, uint256 denom) internal {
        uint64 e = kuruEpoch_[i];
        Epoch storage ep = kuruEpochs_[i][e];
        uint256 w = Math.mulDiv(Math.mulDiv(shares, WAD, denom), WAD - ep.claimedWad, WAD);
        if (w == 0) return;
        Claim storage c = kuruClaims_[owner][i];
        if (c.wad > 0 && c.epoch != e) _payKuruClaim(owner, i, owner);
        ep.claimedWad += w;
        c.epoch = e;
        c.wad += w;
        emit KuruClaimDeferred(owner, i, e, w);
    }

    /// @dev At the first successful sync after claims were deferred, sets aside the claimed fraction of what the leg
    /// held (the cancel refund, and the receipts of its tracked fills, which leave the books with their cost).
    function _resolveKuruEpoch(uint256 i, uint256 refund, uint256 units, uint256 receipts, uint256 paid) internal {
        uint64 e = kuruEpoch_[i];
        Epoch storage ep = kuruEpochs_[i][e];
        uint256 claimed = ep.claimedWad;
        if (claimed == 0) return;
        ep.cash = Math.mulDiv(refund, claimed, WAD);
        ep.units = Math.mulDiv(receipts, claimed, WAD);
        ep.resolved = true;
        kuruCashSetAside_ += ep.cash;
        kuruUnitsSetAside_[i] += ep.units;
        _release(i, Math.mulDiv(units, claimed, WAD), Math.mulDiv(paid, claimed, WAD));
        kuruEpoch_[i] = e + 1;
    }

    /// @dev Pays `owner`'s resolved claim on leg `i` to `receiver`; the last claimant of an epoch takes the remainder.
    function _payKuruClaim(address owner, uint256 i, address receiver) internal returns (uint256 cash, uint256 receipts) {
        Claim memory c = kuruClaims_[owner][i];
        Epoch storage ep = kuruEpochs_[i][c.epoch];
        if (c.wad == 0 || !ep.resolved) revert NothingToClaim();
        ep.paidWad += c.wad;
        if (ep.paidWad == ep.claimedWad) {
            cash = ep.cash - ep.paidCash;
            receipts = ep.units - ep.paidUnits;
        } else {
            cash = Math.mulDiv(ep.cash, c.wad, ep.claimedWad);
            receipts = Math.mulDiv(ep.units, c.wad, ep.claimedWad);
        }
        ep.paidCash += cash;
        ep.paidUnits += receipts;
        delete kuruClaims_[owner][i];
        kuruCashSetAside_ -= cash;
        kuruUnitsSetAside_[i] -= receipts;
        if (cash > 0) asset.safeTransfer(receiver, cash);
        if (receipts > 0) strategies_[i].receipt.safeTransfer(receiver, receipts);
        emit KuruClaimPaid(owner, i, receiver, cash, receipts);
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Base yield                                 */
    /* -------------------------------------------------------------------------- */

    /// @dev Source assets the vault can withdraw now: its own source value, bounded by what the source pays out.
    function _sourceLiquid() internal view returns (uint256) {
        if (sourceShares == 0) return 0;
        (uint256 withdrawable,) = sourceProbe.liquidity();
        uint256 value = sourceAssets();
        return value < withdrawable ? value : withdrawable;
    }

    /// @dev Up to `wanted` source shares, bounded by what the source can pay now.
    function _payableSourceShares(uint256 wanted) internal view returns (uint256) {
        (uint256 withdrawable,) = sourceProbe.liquidity();
        uint256 limit = yieldSource.convertToShares(withdrawable);
        return wanted < limit ? wanted : limit;
    }

    /// @dev Withdraws from the source what the vault's own balance lacks to cover `needed`.
    function _fundFromSource(uint256 needed) internal {
        uint256 balance = _cash();
        if (balance >= needed || address(yieldSource) == address(0)) return;
        uint256 assets = needed - balance;
        IERC20 shareToken = IERC20(address(yieldSource));
        uint256 before = shareToken.balanceOf(address(this));
        yieldSource.withdraw(assets, address(this), address(this));
        uint256 burned = before - shareToken.balanceOf(address(this));
        sourceShares = burned < sourceShares ? sourceShares - burned : 0;
        emit SourceWithdrawn(assets, burned);
    }

    /// @dev Deposits the vault's balance beyond `reserve` into the source while its pool is below 90% utilization.
    /// A source that refuses the deposit (cap, pause) leaves the cash idle.
    function _depositToSource(uint256 reserve) internal {
        if (address(yieldSource) == address(0)) return;
        uint256 balance = _cash();
        if (balance <= reserve) return;
        uint256 amount = balance - reserve;
        if (sourceUtilizationBps() >= SOURCE_MAX_UTILIZATION_BPS || yieldSource.previewDeposit(amount) == 0) return;
        IERC20 shareToken = IERC20(address(yieldSource));
        uint256 before = shareToken.balanceOf(address(this));
        try yieldSource.deposit(amount, address(this)) {
            uint256 minted = shareToken.balanceOf(address(this)) - before;
            sourceShares += minted;
            emit SourceDeposited(amount, minted);
        } catch {}
    }

    /// @dev Redeems a redeemer's `srcShares` for cash as far as the source can pay now; the rest leaves the books to be
    /// paid in kind. A source that cannot pay never makes the redemption revert.
    function _redeemSourceShare(uint256 srcShares) internal returns (uint256 cash, uint256 inKind) {
        uint256 cashShares = _payableSourceShares(srcShares);
        if (cashShares > 0) {
            uint256 before = asset.balanceOf(address(this));
            try yieldSource.redeem(cashShares, address(this), address(this)) {
                cash = asset.balanceOf(address(this)) - before;
                sourceShares -= cashShares;
                emit SourceWithdrawn(cash, cashShares);
            } catch {
                cashShares = 0;
            }
        }
        inKind = srcShares - cashShares;
        sourceShares -= inKind;
    }
}
