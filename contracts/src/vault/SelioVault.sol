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

    uint256 internal constant BPS = 10_000;
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

    Strategy[] internal strategies_;
    /// @notice Active bid of the vault on each strategy's market (0 when none).
    uint256[] public bidOf;
    Released[] internal released_;
    /// @notice Receipt tokens of strategy `i` that a redemption of `owner`'s shares set aside for `owner`.
    mapping(address => mapping(uint256 => uint256)) public claimable;
    uint256[] public totalClaimable;
    /// @notice Source shares the vault minted itself; shares sent to the vault directly are not counted.
    uint256 public sourceShares;

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

    error BadParams();
    error ZeroAmount();
    error ZeroShares();
    error InsufficientShares(uint256 shares, uint256 minShares);
    error SourceNotTight();

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 asset_,
        ExitMarket[] memory markets,
        uint16[] memory minDiscountBps,
        uint16[] memory maxShareBps,
        IERC4626 yieldSource_,
        ISourceProbe sourceProbe_
    ) ERC20(name_, symbol_) {
        uint256 n = markets.length;
        if (n == 0 || n > MAX_STRATEGIES || minDiscountBps.length != n || maxShareBps.length != n) revert BadParams();
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
        }
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

    /// @notice Vault asset held directly plus the escrow of the vault's live bids.
    function idleAssets() public view returns (uint256 idle) {
        idle = asset.balanceOf(address(this));
        for (uint256 i; i < strategies_.length; ++i) {
            idle += _escrowOf(i);
        }
    }

    /// @notice Receipt units of strategy `i` bought through the vault's own bids and still held for its depositors.
    function heldUnits(uint256 i) public view returns (uint256) {
        (uint256 units,) = strategies_[i].market.fillsOf(address(this), address(asset));
        return units - released_[i].units;
    }

    /// @notice Escrow spent on the units of `heldUnits(i)`.
    function heldCost(uint256 i) public view returns (uint256) {
        (, uint256 paid) = strategies_[i].market.fillsOf(address(this), address(asset));
        return paid - released_[i].cost;
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
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert InsufficientShares(shares, minShares);
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _refreshBids(0);
    }

    /// @notice Redeems `shares` of `owner` for idle capital now and the matching share of held receipts in kind.
    /// Strategies listed in `skip` have their receipts set aside for `owner` (see `claim`) instead of transferred.
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
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        assets = Math.mulDiv(idleAssets(), shares, denom);
        receipts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            receipts[i] = Math.mulDiv(_poolReceipts(i), shares, denom);
            _release(i, Math.mulDiv(heldUnits(i), shares, denom), Math.mulDiv(heldCost(i), shares, denom));
        }
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
        _refreshBids(assets);
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

    /* -------------------------------------------------------------------------- */
    /*                            Permissionless upkeep                           */
    /* -------------------------------------------------------------------------- */

    /// @notice Redeems up to `assets` of the tracked receipts of strategy `i` now that its pool is liquid.
    function recover(uint256 i, uint256 assets) external nonReentrant returns (uint256 redeemed) {
        uint256 held = heldAssets(i);
        if (assets > held) assets = held;
        if (assets == 0) revert ZeroAmount();
        ExitMarket market = strategies_[i].market;
        uint256 u0 = market.unitsOf(address(this));
        redeemed = market.redeemReceipt(assets, address(this));
        uint256 out = u0 - market.unitsOf(address(this));
        uint256 units = heldUnits(i);
        uint256 cost = heldCost(i);
        uint256 du = out < units ? out : units;
        if (du == units || _poolReceipts(i) == 0) _release(i, units, cost);
        else _release(i, du, Math.mulDiv(cost, du, units));
        emit Recovered(i, msg.sender, redeemed);
        _refreshBids(0);
    }

    /// @notice Resizes the vault's bids to its current capital.
    function refreshBids() external nonReentrant {
        _refreshBids(0);
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

    /// @dev Receipt balance of strategy `i` minus the receipts set aside for holders.
    function _poolReceipts(uint256 i) internal view returns (uint256) {
        uint256 balance = strategies_[i].receipt.balanceOf(address(this));
        uint256 setAside = totalClaimable[i];
        return balance > setAside ? balance - setAside : 0;
    }

    function _release(uint256 i, uint256 units, uint256 cost) internal {
        Released storage r = released_[i];
        r.units += units;
        r.cost += cost;
    }

    /// @dev Sizes every strategy's bid for the capital left after paying out `reserve`, then applies the sizes in
    /// place: shrinks and closes first so their refunds fund the grows, then (after taking any shortfall from the
    /// yield source) grows and new bids; cash beyond bid escrow and `reserve` then goes to the source.
    function _refreshBids(uint256 reserve) internal {
        uint256 total = totalAssets() - reserve;
        uint256 budget = idleAssets() + _sourceLiquid() - reserve;
        uint256 n = strategies_.length;
        uint256[] memory room = new uint256[](n);
        uint256[] memory want = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            (room[i], want[i]) = _sizeBid(i, total, budget);
            budget -= want[i];
        }
        uint256 growth;
        for (uint256 i; i < n; ++i) {
            uint256 escrow = _liveEscrow(i);
            if (want[i] <= escrow) _applyBid(i, room[i], want[i]);
            else growth += want[i] - escrow;
        }
        _fundFromSource(growth + reserve);
        for (uint256 i; i < n; ++i) {
            if (want[i] > _escrowOf(i)) _applyBid(i, room[i], want[i]);
        }
        _depositToSource(reserve);
        emit BidsRefreshed(total, idleAssets() - reserve);
    }

    /// @dev Room under strategy `i`'s cap (on holdings at cost) and the escrow its bid should hold.
    function _sizeBid(uint256 i, uint256 total, uint256 budget) internal view returns (uint256 room, uint256 want) {
        Strategy storage s = strategies_[i];
        uint256 cap = Math.mulDiv(total, s.maxShareBps, BPS);
        uint256 held = heldCost(i);
        room = cap > held ? cap - held : 0;
        want = budget < room ? budget : room;
        uint256 minEscrow = s.market.minEscrowOf(address(asset));
        if (want < (minEscrow > 1 ? minEscrow : 1)) want = 0;
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
        uint256 balance = asset.balanceOf(address(this));
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
        uint256 balance = asset.balanceOf(address(this));
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
