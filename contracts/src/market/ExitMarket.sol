// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceRouter} from "../shared/oracle/PriceRouter.sol";

/// @title ExitMarket
/// @notice Exit market for the deposit receipts of one lending pool: Dutch-auction sessions, escrowed limit bids,
/// buy-and-repay for borrowers of the same asset, matching, redemption and the pool's exit capacity.
/// @dev Borrowers of the same asset buy receipts at a discount: the market flash-borrows the underlying, repays
/// their debt on their behalf and redeems the seller's receipts with the liquidity that the repayment creates, so
/// the pool's withdrawable liquidity is unchanged.
/// There is no owner and no admin function. Every fill pays a fixed 0.2% fee of its payment, out of what the seller
/// receives, to `feeRecipient`.
abstract contract ExitMarket is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    enum PayMode {
        Wallet,
        Collateral
    }

    struct SessionParams {
        uint16 startBps;
        uint16 stepBps;
        uint32 stepInterval;
        uint16 capBps;
        uint32 duration;
        uint8 payMask;
    }

    struct Session {
        address seller;
        uint64 startedAt;
        uint64 endsAt;
        uint16 startBps;
        uint16 stepBps;
        uint16 capBps;
        uint8 payMask;
        uint32 stepInterval;
        uint256 units;
    }

    struct Bid {
        address bidder;
        uint16 minDiscountBps;
        uint8 payIdx;
        uint256 maxAssets;
        uint256 escrow;
    }

    struct Capacity {
        uint256 withdrawable;
        uint256 supplied;
        uint256 utilizationBps;
        uint256 debtorCapacity;
        uint256 sessionAssets;
    }

    struct Fill {
        uint256 units;
        uint256 paid;
    }

    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_DISCOUNT_BPS = 5_000;
    uint32 public constant MAX_SESSION_DURATION = 30 days;
    uint256 public constant MAX_PAY_TOKENS = 8;
    /// @notice Protocol fee on every fill's payment, in basis points.
    uint16 public constant FEE_BPS = 20;

    IERC20 public immutable receipt;
    address public immutable underlying;
    PriceRouter public immutable prices;
    uint8 internal immutable underlyingDecimals;
    /// @notice Receives every fee, in the fill's pay token.
    address public immutable feeRecipient;

    address[] internal payTokens_;
    uint256 public nextSessionId = 1;
    uint256 public nextBidId = 1;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => Bid) public bids;
    mapping(address => uint256) public totalEscrow;
    uint256 public totalSessionUnits;
    uint256[] internal activeBidIds_;
    mapping(uint256 => uint256) internal activeBidPos_; // index + 1
    /// @notice Smallest escrow a bid paying in that token may hold.
    mapping(address => uint256) public minEscrowOf;
    /// @notice Cumulative fills of a bidder's bids per pay token: receipt units received and escrow paid.
    mapping(address => mapping(address => Fill)) public fillsOf;

    event SessionOpened(
        uint256 indexed sessionId, address indexed seller, uint256 assets, uint256 units, SessionParams params
    );
    event UnsoldWithdrawn(uint256 indexed sessionId, address indexed seller, uint256 units, uint256 assets);
    event Bought(
        uint256 indexed sessionId,
        address indexed buyer,
        uint256 assets,
        uint256 debtRepaid,
        uint16 discountBps,
        address payToken,
        uint256 paid,
        uint256 fee,
        PayMode mode
    );
    event BidPlaced(
        uint256 indexed bidId,
        address indexed bidder,
        uint16 minDiscountBps,
        address payToken,
        uint256 maxAssets,
        uint256 escrow
    );
    event BidCancelled(uint256 indexed bidId, address indexed bidder, uint256 refunded);
    event BidResized(uint256 indexed bidId, address indexed bidder, uint256 maxAssets, uint256 escrow);
    event BidFilled(
        uint256 indexed bidId,
        uint256 indexed sessionId,
        address indexed seller,
        uint256 assets,
        uint256 paid,
        uint256 fee,
        uint16 discountBps
    );
    event ReceiptRedeemed(address indexed holder, address indexed to, uint256 assets);

    error ZeroAmount();
    error BadParams();
    error NotSeller();
    error NotBidder();
    error SessionClosed();
    error PayTokenNotAccepted();
    error PriceTooHigh(uint256 price, uint256 maxPay);
    error DebtTooSmall(uint256 debt, uint256 assets);
    error NotEnoughUnits();
    error DiscountBelowBid();
    error UnknownBid();
    error InsufficientFill(uint256 filled, uint256 minFilled);
    error HealthDecreased(uint256 before, uint256 afterwards);
    error SamePaymentAsset();
    error EscrowTouched();
    error BidTooSmall();

    constructor(
        IERC20 receipt_,
        address underlying_,
        PriceRouter prices_,
        address[] memory payTokenList,
        uint256[] memory minEscrows,
        address feeRecipient_
    ) {
        uint256 n = payTokenList.length;
        if (n == 0 || n > MAX_PAY_TOKENS) revert BadParams();
        if (minEscrows.length != n) revert BadParams();
        if (feeRecipient_ == address(0)) revert BadParams();
        for (uint256 i; i < n; ++i) {
            address token = payTokenList[i];
            if (token == address(0) || token == address(receipt_)) revert BadParams();
            for (uint256 j; j < i; ++j) {
                if (payTokenList[j] == token) revert BadParams();
            }
            if (token != underlying_ && (prices_.feedOf(token) == address(0) || prices_.feedOf(underlying_) == address(0)))
            {
                revert BadParams();
            }
        }
        receipt = receipt_;
        underlying = underlying_;
        prices = prices_;
        underlyingDecimals = IERC20Metadata(underlying_).decimals();
        feeRecipient = feeRecipient_;
        payTokens_ = payTokenList;
        for (uint256 i; i < n; ++i) {
            minEscrowOf[payTokenList[i]] = minEscrows[i];
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Venue hooks                                */
    /* -------------------------------------------------------------------------- */

    /// @dev Receipt units held by `account` (Aave: scaled balance; vault: shares).
    function _unitsOf(address account) internal view virtual returns (uint256);

    /// @dev Underlying value of `units`, rounded down.
    function _unitsToAssets(uint256 units) internal view virtual returns (uint256);

    function _assetsToUnits(uint256 assets, bool roundUp) internal view virtual returns (uint256);

    /// @dev Moves at most `units` escrowed units from the market to `to`.
    function _pushUnits(address to, uint256 units) internal virtual;

    /// @dev Moves receipts worth `assets` straight from `from` to `to`.
    function _transferReceiptFrom(address from, address to, uint256 assets) internal virtual;

    /// @dev Current same-asset debt of `borrower`.
    function _debtOf(address borrower, bytes calldata venueData) internal view virtual returns (uint256);

    /// @dev Repays `borrower`'s debt with flash liquidity and redeems escrowed receipts worth `assets` to return it.
    /// Returns the debt actually repaid (`assets` minus any flash or exit fee).
    function _repayFor(address borrower, uint256 assets, bytes calldata venueData)
        internal
        virtual
        returns (uint256 debtRepaid);

    /// @dev Takes `amount` of `payToken` from the buyer's freed collateral and sends it to `to`.
    function _payWithCollateral(address buyer, address payToken, uint256 amount, address to, bytes calldata venueData)
        internal
        virtual;

    /// @dev Health metric of `borrower`, higher is safer.
    function _healthOf(address borrower, bytes calldata venueData) internal view virtual returns (uint256);

    /// @dev Pulls receipts worth `assets` from `holder`, redeems them and sends the underlying to `to`.
    /// Underlying actually sent (can be a few wei below `assets` because of receipt rounding).
    function _redeemFrom(address holder, uint256 assets, address to) internal virtual returns (uint256 redeemed);

    function _poolStats() internal view virtual returns (uint256 withdrawable, uint256 supplied, uint256 borrowed);

    /// @notice Underlying value of `amount` receipt tokens.
    function receiptValue(uint256 amount) public view virtual returns (uint256);

    /* -------------------------------------------------------------------------- */
    /*                                  Sessions                                  */
    /* -------------------------------------------------------------------------- */

    /// @notice Escrows `amount` receipt tokens from the caller and opens a Dutch auction for them.
    function openSession(uint256 amount, SessionParams calldata p) external nonReentrant returns (uint256 sessionId) {
        if (amount == 0) revert ZeroAmount();
        if (
            p.capBps > MAX_DISCOUNT_BPS || p.startBps > p.capBps || p.stepInterval == 0 || p.duration == 0
                || p.duration > MAX_SESSION_DURATION || p.payMask == 0 || (uint256(p.payMask) >> payTokens_.length) != 0
        ) revert BadParams();
        uint256 before = _unitsOf(address(this));
        receipt.safeTransferFrom(msg.sender, address(this), amount);
        uint256 units = _unitsOf(address(this)) - before;
        if (units == 0) revert ZeroAmount();
        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            seller: msg.sender,
            startedAt: uint64(block.timestamp),
            endsAt: uint64(block.timestamp + p.duration),
            startBps: p.startBps,
            stepBps: p.stepBps,
            capBps: p.capBps,
            payMask: p.payMask,
            stepInterval: p.stepInterval,
            units: units
        });
        totalSessionUnits += units;
        emit SessionOpened(sessionId, msg.sender, _unitsToAssets(units), units, p);
    }

    /// @notice Returns `units` unsold units to the seller (all of them with `type(uint256).max`), at any time.
    function withdrawUnsold(uint256 sessionId, uint256 units) external nonReentrant returns (uint256 assets) {
        Session storage s = sessions[sessionId];
        if (s.seller != msg.sender) revert NotSeller();
        if (units == type(uint256).max) units = s.units;
        if (units == 0) revert ZeroAmount();
        if (units > s.units) revert NotEnoughUnits();
        s.units -= units;
        totalSessionUnits -= units;
        assets = _unitsToAssets(units);
        _pushUnits(msg.sender, units);
        emit UnsoldWithdrawn(sessionId, msg.sender, units, assets);
    }

    /// @notice Current discount of a session in basis points; 0 for an unknown session.
    function discountOf(uint256 sessionId) public view returns (uint16) {
        Session storage s = sessions[sessionId];
        if (s.seller == address(0)) return 0;
        uint256 d = uint256(s.startBps) + ((block.timestamp - s.startedAt) / s.stepInterval) * s.stepBps;
        return uint16(d > s.capBps ? s.capBps : d);
    }

    function remainingAssets(uint256 sessionId) public view returns (uint256) {
        return _unitsToAssets(sessions[sessionId].units);
    }

    function isOpen(uint256 sessionId) public view returns (bool) {
        Session storage s = sessions[sessionId];
        return s.seller != address(0) && block.timestamp < s.endsAt && s.units > 0;
    }

    /* -------------------------------------------------------------------------- */
    /*                          Borrowers buy and repay                           */
    /* -------------------------------------------------------------------------- */

    /// @notice Buys receipts worth `assets` from a session. The venue repays the caller's same-asset debt inside a
    /// flash loan; the caller then pays the quote from its wallet: the payment minus the fee to the seller and the
    /// fee to `feeRecipient`.
    function buyAndRepay(uint256 sessionId, uint256 assets, uint8 payIdx, uint256 maxPay, bytes calldata venueData)
        external
        nonReentrant
        returns (uint256 paid, uint256 debtRepaid)
    {
        Session storage s = sessions[sessionId];
        (address payToken, uint16 d, uint256 price) = _prepareBuy(s, sessionId, assets, payIdx, maxPay, venueData);
        paid = price;
        debtRepaid = _settleRepay(s, msg.sender, assets, venueData);
        uint256 fee = _paySeller(payToken, msg.sender, s.seller, paid);
        emit Bought(sessionId, msg.sender, assets, debtRepaid, d, payToken, paid, fee, PayMode.Wallet);
    }

    /// @notice Flash mode: as `buyAndRepay`, but the payment comes from collateral that the repayment frees.
    /// The caller's health must not decrease.
    function buyAndRepayWithCollateral(
        uint256 sessionId,
        uint256 assets,
        uint8 payIdx,
        uint256 maxPay,
        bytes calldata venueData
    ) external nonReentrant returns (uint256 paid, uint256 debtRepaid) {
        Session storage s = sessions[sessionId];
        (address payToken, uint16 d, uint256 price) = _prepareBuy(s, sessionId, assets, payIdx, maxPay, venueData);
        if (payToken == underlying) revert SamePaymentAsset();
        paid = price;
        uint256 healthBefore = _healthOf(msg.sender, venueData);
        debtRepaid = _settleRepay(s, msg.sender, assets, venueData);
        _payWithCollateral(msg.sender, payToken, paid, address(this), venueData);
        uint256 fee = _paySeller(payToken, address(this), s.seller, paid);
        uint256 healthAfter = _healthOf(msg.sender, venueData);
        if (healthAfter < healthBefore) revert HealthDecreased(healthBefore, healthAfter);
        emit Bought(sessionId, msg.sender, assets, debtRepaid, d, payToken, paid, fee, PayMode.Collateral);
    }

    function _prepareBuy(
        Session storage s,
        uint256 sessionId,
        uint256 assets,
        uint8 payIdx,
        uint256 maxPay,
        bytes calldata venueData
    ) internal view returns (address payToken, uint16 d, uint256 price) {
        if (assets == 0) revert ZeroAmount();
        if (!isOpen(sessionId)) revert SessionClosed();
        if (payIdx >= payTokens_.length || ((s.payMask >> payIdx) & 1) == 0) revert PayTokenNotAccepted();
        if (assets > _unitsToAssets(s.units)) revert NotEnoughUnits();
        uint256 debt = _debtOf(msg.sender, venueData);
        if (debt < assets) revert DebtTooSmall(debt, assets);
        payToken = payTokens_[payIdx];
        d = discountOf(sessionId);
        price = quote(assets, d, payToken);
        if (price > maxPay) revert PriceTooHigh(price, maxPay);
    }

    /// @dev Runs the venue's repayment and charges the escrowed units it burned to the bought session.
    function _settleRepay(Session storage s, address buyer, uint256 assets, bytes calldata venueData)
        internal
        returns (uint256 debtRepaid)
    {
        uint256 before = _unitsOf(address(this));
        debtRepaid = _repayFor(buyer, assets, venueData);
        uint256 burned = before - _unitsOf(address(this));
        if (burned > s.units) revert NotEnoughUnits();
        s.units -= burned;
        totalSessionUnits -= burned;
    }

    /* -------------------------------------------------------------------------- */
    /*                                 Limit bids                                 */
    /* -------------------------------------------------------------------------- */

    /// @notice Escrows `escrow` of a pay token for a bid that buys up to `maxAssets` of receipt value at a discount
    /// of at least `minDiscountBps`.
    function placeBid(uint16 minDiscountBps, uint8 payIdx, uint256 maxAssets, uint256 escrow)
        external
        nonReentrant
        returns (uint256 bidId)
    {
        if (maxAssets == 0 || escrow == 0) revert ZeroAmount();
        if (minDiscountBps > MAX_DISCOUNT_BPS || payIdx >= payTokens_.length) revert BadParams();
        address payToken = payTokens_[payIdx];
        _checkBidSize(payToken, minDiscountBps, maxAssets, escrow);
        IERC20(payToken).safeTransferFrom(msg.sender, address(this), escrow);
        totalEscrow[payToken] += escrow;
        bidId = nextBidId++;
        bids[bidId] = Bid({
            bidder: msg.sender, minDiscountBps: minDiscountBps, payIdx: payIdx, maxAssets: maxAssets, escrow: escrow
        });
        activeBidIds_.push(bidId);
        activeBidPos_[bidId] = activeBidIds_.length;
        emit BidPlaced(bidId, msg.sender, minDiscountBps, payToken, maxAssets, escrow);
    }

    /// @notice Deletes the caller's bid and refunds its remaining escrow.
    function cancelBid(uint256 bidId) external nonReentrant returns (uint256 refunded) {
        Bid storage b = bids[bidId];
        if (b.bidder != msg.sender) revert NotBidder();
        refunded = _closeBid(bidId, b);
        emit BidCancelled(bidId, msg.sender, refunded);
    }

    /// @notice Sets the remaining `maxAssets` and `escrow` of the caller's live bid under the same id, pulling an
    /// escrow increase from the caller or refunding a decrease.
    function resizeBid(uint256 bidId, uint256 maxAssets, uint256 escrow) external nonReentrant {
        Bid storage b = bids[bidId];
        if (b.bidder != msg.sender) revert NotBidder();
        if (maxAssets == 0 || escrow == 0) revert ZeroAmount();
        address payToken = payTokens_[b.payIdx];
        _checkBidSize(payToken, b.minDiscountBps, maxAssets, escrow);
        uint256 old = b.escrow;
        b.maxAssets = maxAssets;
        b.escrow = escrow;
        totalEscrow[payToken] = totalEscrow[payToken] + escrow - old;
        if (escrow > old) IERC20(payToken).safeTransferFrom(msg.sender, address(this), escrow - old);
        else if (escrow < old) IERC20(payToken).safeTransfer(msg.sender, old - escrow);
        emit BidResized(bidId, msg.sender, maxAssets, escrow);
    }

    /// @notice Receipt value bid `bidId` can buy at `discountBps`; 0 for an unknown bid.
    function bidCapacity(uint256 bidId, uint16 discountBps) public view returns (uint256) {
        Bid storage b = bids[bidId];
        if (b.bidder == address(0)) return 0;
        uint256 cap = assetsFor(b.escrow, discountBps, payTokens_[b.payIdx]);
        return cap < b.maxAssets ? cap : b.maxAssets;
    }

    /// @notice Sells the caller's wallet receipts into the listed bids in order, each at its own limit discount.
    /// `paid[i]` is what bid `i`'s escrow paid; the seller receives `paid[i] - feeOf(paid[i])`.
    function sellNow(uint256 assets, uint256[] calldata bidIds, uint16 maxDiscountBps, uint8 payMask, uint256 minFilled)
        external
        nonReentrant
        returns (uint256 filled, uint256[] memory paid)
    {
        if (assets == 0) revert ZeroAmount();
        paid = new uint256[](bidIds.length);
        for (uint256 i; i < bidIds.length && filled < assets; ++i) {
            uint256 bidId = bidIds[i];
            Bid storage b = bids[bidId];
            if (b.bidder == address(0) || b.minDiscountBps > maxDiscountBps || ((payMask >> b.payIdx) & 1) == 0) {
                continue;
            }
            uint256 f = bidCapacity(bidId, b.minDiscountBps);
            if (f > assets - filled) f = assets - filled;
            if (f == 0) continue;
            address payToken = payTokens_[b.payIdx];
            uint256 pay = quote(f, b.minDiscountBps, payToken);
            if (pay > b.escrow) pay = b.escrow;
            _consumeBid(b, f, pay);
            filled += f;
            paid[i] = pay;
            address bidder = b.bidder;
            uint256 u0 = _unitsOf(bidder);
            _transferReceiptFrom(msg.sender, bidder, f);
            _recordFill(bidder, payToken, u0, pay);
            uint256 fee = _paySeller(payToken, address(this), msg.sender, pay);
            emit BidFilled(bidId, 0, msg.sender, f, pay, fee, b.minDiscountBps);
            if (bidCapacity(bidId, b.minDiscountBps) == 0) _autoClose(bidId, b);
        }
        if (filled < minFilled) revert InsufficientFill(filled, minFilled);
    }

    /// @notice Fills a bid from a session once the session's discount reaches the bid's minimum; anyone can call.
    /// The bid pays the session's current price; the session's seller receives it minus the fee.
    function matchBid(uint256 sessionId, uint256 bidId, uint256 assets)
        external
        nonReentrant
        returns (uint256 filled, uint256 paid)
    {
        Bid storage b = bids[bidId];
        if (b.bidder == address(0)) revert UnknownBid();
        if (!isOpen(sessionId)) revert SessionClosed();
        Session storage s = sessions[sessionId];
        if (((s.payMask >> b.payIdx) & 1) == 0) revert PayTokenNotAccepted();
        uint16 d = discountOf(sessionId);
        if (d < b.minDiscountBps) revert DiscountBelowBid();
        filled = bidCapacity(bidId, d);
        uint256 remaining = _unitsToAssets(s.units);
        if (remaining < filled) filled = remaining;
        if (assets < filled) filled = assets;
        if (filled == 0) revert ZeroAmount();
        uint256 units = _assetsToUnits(filled, true);
        if (units > s.units) units = s.units;
        address payToken = payTokens_[b.payIdx];
        paid = quote(filled, d, payToken);
        if (paid > b.escrow) paid = b.escrow;
        _consumeBid(b, filled, paid);
        s.units -= units;
        totalSessionUnits -= units;
        address bidder = b.bidder;
        uint256 u0 = _unitsOf(bidder);
        _pushUnits(bidder, units);
        _recordFill(bidder, payToken, u0, paid);
        address seller = s.seller;
        uint256 fee = _paySeller(payToken, address(this), seller, paid);
        emit BidFilled(bidId, sessionId, seller, filled, paid, fee, d);
        if (bidCapacity(bidId, b.minDiscountBps) == 0) _autoClose(bidId, b);
    }

    function _checkBidSize(address payToken, uint16 minDiscountBps, uint256 maxAssets, uint256 escrow) internal view {
        if (escrow < minEscrowOf[payToken]) revert BidTooSmall();
        uint256 cap = assetsFor(escrow, minDiscountBps, payToken);
        if ((cap < maxAssets ? cap : maxAssets) == 0) revert BidTooSmall();
    }

    function _consumeBid(Bid storage b, uint256 assets, uint256 pay) internal {
        b.escrow -= pay;
        b.maxAssets -= assets;
        totalEscrow[payTokens_[b.payIdx]] -= pay;
    }

    function _recordFill(address bidder, address payToken, uint256 unitsBefore, uint256 paid) internal {
        Fill storage f = fillsOf[bidder][payToken];
        f.units += _unitsOf(bidder) - unitsBefore;
        f.paid += paid;
    }

    function _autoClose(uint256 bidId, Bid storage b) internal {
        address bidder = b.bidder;
        uint256 refunded = _closeBid(bidId, b);
        emit BidCancelled(bidId, bidder, refunded);
    }

    function _closeBid(uint256 bidId, Bid storage b) internal returns (uint256 refunded) {
        address bidder = b.bidder;
        address payToken = payTokens_[b.payIdx];
        refunded = b.escrow;
        totalEscrow[payToken] -= refunded;
        delete bids[bidId];
        uint256 pos = activeBidPos_[bidId];
        uint256 last = activeBidIds_.length;
        if (pos != last) {
            uint256 lastId = activeBidIds_[last - 1];
            activeBidIds_[pos - 1] = lastId;
            activeBidPos_[lastId] = pos;
        }
        activeBidIds_.pop();
        delete activeBidPos_[bidId];
        if (refunded > 0) IERC20(payToken).safeTransfer(bidder, refunded);
    }

    /// @dev Pays a fill: `payment - fee` to the seller, then the fee to `feeRecipient`. With `payer` the market the
    /// tokens leave its own balance (bid escrow or freed collateral it just received), otherwise they are pulled.
    function _paySeller(address payToken, address payer, address seller, uint256 payment) internal returns (uint256 fee) {
        fee = feeOf(payment);
        IERC20 token = IERC20(payToken);
        if (payer == address(this)) {
            token.safeTransfer(seller, payment - fee);
            if (fee > 0) token.safeTransfer(feeRecipient, fee);
        } else {
            token.safeTransferFrom(payer, seller, payment - fee);
            if (fee > 0) token.safeTransferFrom(payer, feeRecipient, fee);
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                                  Recovery                                  */
    /* -------------------------------------------------------------------------- */

    /// @notice Pulls the caller's receipts worth `assets`, redeems them and sends the underlying to `to`.
    /// @dev Works only while the pool has liquidity. Escrowed receipts are never touched.
    function redeemReceipt(uint256 assets, address to) external nonReentrant returns (uint256 redeemed) {
        if (assets == 0) revert ZeroAmount();
        redeemed = _redeemFrom(msg.sender, assets, to);
        if (_unitsOf(address(this)) < totalSessionUnits) revert EscrowTouched();
        emit ReceiptRedeemed(msg.sender, to, redeemed);
    }

    /* -------------------------------------------------------------------------- */
    /*                                   Pricing                                  */
    /* -------------------------------------------------------------------------- */

    /// @notice Pay-token amount that buys receipts worth `assets` at `discountBps`, rounded up.
    function quote(uint256 assets, uint16 discountBps, address payToken) public view returns (uint256) {
        uint256 net = assets * (BPS - discountBps);
        if (payToken == underlying) return Math.ceilDiv(net, BPS);
        uint256 pu = prices.priceOf(underlying);
        uint256 pp = prices.priceOf(payToken);
        uint256 dp = IERC20Metadata(payToken).decimals();
        return Math.mulDiv(net * pu, 10 ** dp, pp * 10 ** underlyingDecimals * BPS, Math.Rounding.Ceil);
    }

    /// @notice Receipt value that `payAmount` buys at `discountBps`, rounded down.
    function assetsFor(uint256 payAmount, uint16 discountBps, address payToken) public view returns (uint256) {
        if (payAmount == 0) return 0;
        uint256 keep = BPS - discountBps;
        if (payToken == underlying) return Math.mulDiv(payAmount, BPS, keep);
        uint256 pu = prices.priceOf(underlying);
        uint256 pp = prices.priceOf(payToken);
        uint256 dp = IERC20Metadata(payToken).decimals();
        return Math.mulDiv(payAmount * pp, 10 ** underlyingDecimals * BPS, pu * keep * 10 ** dp);
    }

    /// @notice Protocol fee of a fill that pays `payment`, rounded down.
    function feeOf(uint256 payment) public pure returns (uint256) {
        return payment * FEE_BPS / BPS;
    }

    /* -------------------------------------------------------------------------- */
    /*                                    Views                                   */
    /* -------------------------------------------------------------------------- */

    function payTokens() external view returns (address[] memory) {
        return payTokens_;
    }

    function activeBidIds() external view returns (uint256[] memory) {
        return activeBidIds_;
    }

    function activeBidCount() external view returns (uint256) {
        return activeBidIds_.length;
    }

    /// @notice Live-bid ids at positions `offset ... min(offset + limit, activeBidCount()) - 1`.
    function activeBidIdsPage(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 end = _pageEnd(offset, limit);
        if (offset >= end) return new uint256[](0);
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            ids[i - offset] = activeBidIds_[i];
        }
    }

    /// @notice Receipt value of every live bid whose minimum discount is at most `discountBps`, each valued at its
    /// own minimum discount.
    function bidCapacityAt(uint16 discountBps) external view returns (uint256 total) {
        return _bidCapacityRange(discountBps, 0, activeBidIds_.length);
    }

    /// @notice `bidCapacityAt` over the live bids at positions `offset ... min(offset + limit, activeBidCount()) - 1`.
    function bidCapacityAtPage(uint16 discountBps, uint256 offset, uint256 limit) external view returns (uint256 total) {
        return _bidCapacityRange(discountBps, offset, _pageEnd(offset, limit));
    }

    function unitsOf(address account) external view returns (uint256) {
        return _unitsOf(account);
    }

    function unitsToAssets(uint256 units) external view returns (uint256) {
        return _unitsToAssets(units);
    }

    /// @notice Exit capacity of the pool.
    function capacity() external view returns (Capacity memory c) {
        (uint256 withdrawable, uint256 supplied, uint256 borrowed) = _poolStats();
        c.withdrawable = withdrawable;
        c.supplied = supplied;
        c.utilizationBps = supplied == 0 || withdrawable >= supplied ? 0 : (supplied - withdrawable) * BPS / supplied;
        c.debtorCapacity = borrowed;
        c.sessionAssets = _unitsToAssets(totalSessionUnits);
    }

    function _pageEnd(uint256 offset, uint256 limit) internal view returns (uint256 end) {
        uint256 length = activeBidIds_.length;
        if (offset >= length) return offset;
        end = limit > length - offset ? length : offset + limit;
    }

    function _bidCapacityRange(uint16 discountBps, uint256 from, uint256 to) internal view returns (uint256 total) {
        for (uint256 i = from; i < to; ++i) {
            uint256 id = activeBidIds_[i];
            uint16 minD = bids[id].minDiscountBps;
            if (minD <= discountBps) total += bidCapacity(id, minD);
        }
    }
}
