// Handlers of the 8 SelioMarket events (Part 10 §10.1 F.3).
import { indexer, type Account, type AccountToken, type Bid, type Market, type Session } from "envio";
import { DEPLOYMENT } from "../deployment";
import { accountTokenId, bidEntityId, logId, sessionEntityId } from "../lib/ids";
import { avgDiscountBps, bidCapacity, minBig, ratioBps, sellerNet, shiftDepth } from "../lib/math";
import {
  bumpMarketInterval,
  bumpVaultInterval,
  isSelioVault,
  loadAccounts,
  loadAccountTokens,
  loadFeeTotal,
  loadMarket,
  loadMarketIntervals,
  loadPool,
  loadVault,
  missing,
  rowOf,
  saveRows,
  writeCapacity,
  type Mutable,
} from "../lib/state";

/** E.2, E.3: sets a bid's remaining size and moves its capacity in the market's bid depth. */
function sizeBid(bid: Mutable<Bid>, market: Mutable<Market>, maxAssets: bigint, escrow: bigint): void {
  const before = bid.capacityAssets;
  bid.maxAssets = maxAssets;
  bid.escrow = escrow;
  bid.capacityAssets = bidCapacity(bid);
  Object.assign(market, shiftDepth(market, bid.minDiscountBps, bid.capacityAssets - before));
}

/** E.9: a fill or a withdrawal takes at most what the session still lists. */
function unlist(session: Mutable<Session>, market: Mutable<Market>, assets: bigint): void {
  const taken = minBig(session.listedAssets, assets);
  session.listedAssets -= taken;
  market.sessionAssets -= taken;
}

function sessionFill(session: Mutable<Session>, market: Mutable<Market>, assets: bigint, discountBps: number, timestamp: number): void {
  unlist(session, market, assets);
  session.soldAssets += assets;
  session.fillCount += 1;
  session.discountWeighted += assets * BigInt(discountBps);
  session.avgDiscountBps = avgDiscountBps(session.discountWeighted, session.soldAssets);
  session.lastActivityAt = timestamp;
}

/** E.11: seller and buyer totals of one fill. */
function recordSale(
  accounts: Map<string, Mutable<Account>>,
  tokens: Map<string, Mutable<AccountToken>>,
  fill: { seller: string; buyer: string; payToken: string; assets: bigint; paid: bigint; fee: bigint },
): void {
  rowOf(accounts, fill.seller).soldAssets += fill.assets;
  rowOf(accounts, fill.buyer).boughtAssets += fill.assets;
  const sellerToken = rowOf(tokens, accountTokenId(fill.seller, fill.payToken));
  sellerToken.receivedNet += sellerNet(fill.paid, fill.fee);
  sellerToken.feesPaid += fill.fee;
  rowOf(tokens, accountTokenId(fill.buyer, fill.payToken)).paidAsBuyer += fill.paid;
}

indexer.onEvent({ contract: "SelioMarket", event: "SessionOpened" }, async ({ event, context }) => {
  const { sessionId, seller, assets, units, params } = event.params;
  const timestamp = event.block.timestamp;
  const [market, accounts, intervals, pool] = await Promise.all([
    loadMarket(context, timestamp),
    loadAccounts(context, [seller], timestamp),
    loadMarketIntervals(context, timestamp),
    loadPool(context, timestamp),
  ]);

  context.Session.set({
    id: sessionEntityId(market.id, sessionId),
    market_id: market.id,
    sessionId,
    seller_id: seller,
    openedAssets: assets,
    openedUnits: units,
    startBps: Number(params.startBps),
    stepBps: Number(params.stepBps),
    stepInterval: Number(params.stepInterval),
    capBps: Number(params.capBps),
    duration: Number(params.duration),
    payMask: Number(params.payMask),
    startedAt: timestamp,
    endsAt: timestamp + Number(params.duration),
    openedBlock: event.block.number,
    openedTx: event.transaction.hash,
    soldAssets: 0n,
    fillCount: 0,
    discountWeighted: 0n,
    avgDiscountBps: undefined,
    withdrawnAssets: 0n,
    withdrawnUnits: 0n,
    listedAssets: assets,
    lastActivityAt: timestamp,
  });
  rowOf(accounts, seller).sessionsOpened += 1;
  saveRows(context.Account, accounts);
  market.sessionsOpened += 1;
  market.sessionAssets += assets;
  market.updatedAt = timestamp;
  context.Market.set(market);
  bumpMarketInterval(context, intervals, { sessionsOpened: 1 });
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "UnsoldWithdrawn" }, async ({ event, context }) => {
  const { sessionId, units, assets } = event.params;
  const timestamp = event.block.timestamp;
  const id = sessionEntityId(DEPLOYMENT.market, sessionId);
  const [stored, market, pool] = await Promise.all([
    context.Session.getOrThrow(id, missing("Session", id)),
    loadMarket(context, timestamp),
    loadPool(context, timestamp),
  ]);

  const session: Mutable<Session> = { ...stored };
  unlist(session, market, assets);
  session.withdrawnAssets += assets;
  session.withdrawnUnits += units;
  session.lastActivityAt = timestamp;
  context.Session.set(session);
  market.updatedAt = timestamp;
  context.Market.set(market);
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "Bought" }, async ({ event, context }) => {
  const { sessionId, buyer, assets, debtRepaid, discountBps, payToken, paid, fee, mode } = event.params;
  const timestamp = event.block.timestamp;
  const id = sessionEntityId(DEPLOYMENT.market, sessionId);
  const [stored, market, intervals, pool, feeTotal] = await Promise.all([
    context.Session.getOrThrow(id, missing("Session", id)),
    loadMarket(context, timestamp),
    loadMarketIntervals(context, timestamp),
    loadPool(context, timestamp),
    loadFeeTotal(context, payToken),
  ]);
  const seller = stored.seller_id;
  const [accounts, tokens] = await Promise.all([
    loadAccounts(context, [seller, buyer], timestamp),
    loadAccountTokens(context, [
      [seller, payToken],
      [buyer, payToken],
    ]),
  ]);
  const discount = Number(discountBps);

  context.Fill.set({
    id: logId(event.block.number, event.logIndex),
    market_id: market.id,
    kind: mode === 0n ? "BORROWER_WALLET" : "BORROWER_COLLATERAL",
    session_id: id,
    sessionId,
    bid_id: undefined,
    bidId: undefined,
    seller_id: seller,
    buyer_id: buyer,
    buyerIsSelioVault: isSelioVault(buyer),
    assets,
    paid,
    fee,
    sellerNet: sellerNet(paid, fee),
    payToken,
    discountBps: discount,
    debtRepaid,
    timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    txFrom: (event.transaction.from ?? "").toLowerCase(),
  });

  const session: Mutable<Session> = { ...stored };
  sessionFill(session, market, assets, discount, timestamp);
  context.Session.set(session);

  recordSale(accounts, tokens, { seller, buyer, payToken, assets, paid, fee });
  rowOf(accounts, buyer).debtRepaid += debtRepaid;
  saveRows(context.Account, accounts);
  saveRows(context.AccountToken, tokens);

  feeTotal.fees += fee;
  feeTotal.gross += paid;
  feeTotal.sellerNet += sellerNet(paid, fee);
  feeTotal.fillCount += 1;
  context.FeeTotal.set(feeTotal);

  market.fillCount += 1;
  market.filledAssets += assets;
  market.borrowerFilledAssets += assets;
  market.debtRepaid += debtRepaid;
  market.updatedAt = timestamp;
  context.Market.set(market);
  bumpMarketInterval(context, intervals, { fill: { assets, discountBps: discount, fee, payToken, debtRepaid } });
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "BidPlaced" }, async ({ event, context }) => {
  const { bidId, bidder, minDiscountBps, payToken, maxAssets, escrow } = event.params;
  const timestamp = event.block.timestamp;
  const byVault = isSelioVault(bidder);
  const [market, accounts, tokens, intervals, pool, vault] = await Promise.all([
    loadMarket(context, timestamp),
    loadAccounts(context, [bidder], timestamp),
    loadAccountTokens(context, [[bidder, payToken]]),
    loadMarketIntervals(context, timestamp),
    loadPool(context, timestamp),
    byVault ? loadVault(context, timestamp) : undefined,
  ]);

  const payIsUnderlying = payToken === DEPLOYMENT.underlying;
  const bid: Mutable<Bid> = {
    id: bidEntityId(market.id, bidId),
    market_id: market.id,
    bidId,
    bidder_id: bidder,
    isSelioVault: byVault,
    minDiscountBps: Number(minDiscountBps),
    payToken,
    payIsUnderlying,
    maxAssetsPlaced: maxAssets,
    escrowPlaced: escrow,
    maxAssets: 0n,
    escrow: 0n,
    capacityAssets: 0n,
    capacityExact: payIsUnderlying,
    filledAssets: 0n,
    paidOut: 0n,
    fillCount: 0,
    resizeCount: 0,
    status: "LIVE",
    placedAt: timestamp,
    placedBlock: event.block.number,
    placedTx: event.transaction.hash,
    closedAt: undefined,
    refunded: undefined,
    lastFillTx: undefined,
  };
  sizeBid(bid, market, maxAssets, escrow);
  context.Bid.set(bid);

  market.bidsPlaced += 1;
  market.liveBids += 1;
  if (!bid.capacityExact) market.inexactLiveBids += 1;
  market.updatedAt = timestamp;
  context.Market.set(market);
  rowOf(accounts, bidder).bidsPlaced += 1;
  saveRows(context.Account, accounts);
  rowOf(tokens, accountTokenId(bidder, payToken)).escrowLive += escrow;
  saveRows(context.AccountToken, tokens);
  if (vault !== undefined) {
    vault.liveBid_id = bid.id;
    vault.updatedAt = timestamp;
    context.SelioVaultState.set(vault);
  }
  bumpMarketInterval(context, intervals, { bidsPlaced: 1 });
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "BidResized" }, async ({ event, context }) => {
  const { bidId, maxAssets, escrow } = event.params;
  const timestamp = event.block.timestamp;
  const id = bidEntityId(DEPLOYMENT.market, bidId);
  const [stored, market, pool] = await Promise.all([
    context.Bid.getOrThrow(id, missing("Bid", id)),
    loadMarket(context, timestamp),
    loadPool(context, timestamp),
  ]);
  const tokens = await loadAccountTokens(context, [[stored.bidder_id, stored.payToken]]);

  context.BidResize.set({
    id: logId(event.block.number, event.logIndex),
    bid_id: id,
    maxAssetsBefore: stored.maxAssets,
    escrowBefore: stored.escrow,
    maxAssets,
    escrow,
    timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
  rowOf(tokens, accountTokenId(stored.bidder_id, stored.payToken)).escrowLive += escrow - stored.escrow;
  saveRows(context.AccountToken, tokens);

  const bid: Mutable<Bid> = { ...stored };
  sizeBid(bid, market, maxAssets, escrow);
  bid.resizeCount += 1;
  context.Bid.set(bid);
  market.updatedAt = timestamp;
  context.Market.set(market);
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "BidCancelled" }, async ({ event, context }) => {
  const { bidId, refunded } = event.params;
  const timestamp = event.block.timestamp;
  const id = bidEntityId(DEPLOYMENT.market, bidId);
  const [stored, market, pool] = await Promise.all([
    context.Bid.getOrThrow(id, missing("Bid", id)),
    loadMarket(context, timestamp),
    loadPool(context, timestamp),
  ]);
  const [tokens, vault] = await Promise.all([
    loadAccountTokens(context, [[stored.bidder_id, stored.payToken]]),
    stored.isSelioVault ? loadVault(context, timestamp) : undefined,
  ]);

  // The market closes a bid in the same call as the fill that uses it up (E.4).
  const bid: Mutable<Bid> = {
    ...stored,
    status: stored.lastFillTx === event.transaction.hash ? "CLOSED_AFTER_FILL" : "CANCELLED",
    refunded,
    closedAt: timestamp,
  };
  sizeBid(bid, market, 0n, 0n);
  context.Bid.set(bid);

  market.liveBids -= 1;
  if (!bid.capacityExact) market.inexactLiveBids -= 1;
  market.updatedAt = timestamp;
  context.Market.set(market);
  rowOf(tokens, accountTokenId(bid.bidder_id, bid.payToken)).escrowLive -= refunded;
  saveRows(context.AccountToken, tokens);
  if (vault !== undefined && vault.liveBid_id === id) {
    vault.liveBid_id = undefined;
    vault.updatedAt = timestamp;
    context.SelioVaultState.set(vault);
  }
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "BidFilled" }, async ({ event, context }) => {
  const { bidId, sessionId, seller, assets, paid, fee, discountBps } = event.params;
  const timestamp = event.block.timestamp;
  const bidKey = bidEntityId(DEPLOYMENT.market, bidId);
  const sessionKey = sessionId === 0n ? undefined : sessionEntityId(DEPLOYMENT.market, sessionId);
  const [stored, storedSession, market, intervals, pool] = await Promise.all([
    context.Bid.getOrThrow(bidKey, missing("Bid", bidKey)),
    sessionKey === undefined ? undefined : context.Session.getOrThrow(sessionKey, missing("Session", sessionKey)),
    loadMarket(context, timestamp),
    loadMarketIntervals(context, timestamp),
    loadPool(context, timestamp),
  ]);
  const buyer = stored.bidder_id;
  const payToken = stored.payToken;
  const [accounts, tokens, feeTotal, vault] = await Promise.all([
    loadAccounts(context, [seller, buyer], timestamp),
    loadAccountTokens(context, [
      [seller, payToken],
      [buyer, payToken],
    ]),
    loadFeeTotal(context, payToken),
    stored.isSelioVault ? loadVault(context, timestamp) : undefined,
  ]);
  const discount = Number(discountBps);

  context.Fill.set({
    id: logId(event.block.number, event.logIndex),
    market_id: market.id,
    kind: sessionKey === undefined ? "SELL_NOW" : "AUCTION_MATCH",
    session_id: sessionKey,
    sessionId,
    bid_id: bidKey,
    bidId,
    seller_id: seller,
    buyer_id: buyer,
    buyerIsSelioVault: stored.isSelioVault,
    assets,
    paid,
    fee,
    sellerNet: sellerNet(paid, fee),
    payToken,
    discountBps: discount,
    debtRepaid: undefined,
    timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
    txFrom: (event.transaction.from ?? "").toLowerCase(),
  });

  // E.4: the market takes the fill from the bid's remaining size and escrow.
  const bid: Mutable<Bid> = { ...stored };
  sizeBid(bid, market, bid.maxAssets - assets, bid.escrow - paid);
  bid.filledAssets += assets;
  bid.paidOut += paid;
  bid.fillCount += 1;
  bid.lastFillTx = event.transaction.hash;
  context.Bid.set(bid);

  if (storedSession !== undefined) {
    const session: Mutable<Session> = { ...storedSession };
    sessionFill(session, market, assets, discount, timestamp);
    context.Session.set(session);
  }

  recordSale(accounts, tokens, { seller, buyer, payToken, assets, paid, fee });
  rowOf(tokens, accountTokenId(buyer, payToken)).escrowLive -= paid;
  saveRows(context.Account, accounts);
  saveRows(context.AccountToken, tokens);

  feeTotal.fees += fee;
  feeTotal.gross += paid;
  feeTotal.sellerNet += sellerNet(paid, fee);
  feeTotal.fillCount += 1;
  context.FeeTotal.set(feeTotal);

  market.fillCount += 1;
  market.filledAssets += assets;
  market.bidFilledAssets += assets;
  market.updatedAt = timestamp;
  context.Market.set(market);

  // E.10: the vault's cost basis is what its bid paid.
  if (vault !== undefined) {
    vault.boughtAssets += assets;
    vault.boughtCost += paid;
    vault.boughtFills += 1;
    vault.recoveryRateBps = ratioBps(vault.recoveredAssets, vault.boughtAssets);
    vault.costRecoveryBps = ratioBps(vault.recoveredAssets, vault.boughtCost);
    vault.updatedAt = timestamp;
    context.SelioVaultState.set(vault);
    bumpVaultInterval(context, vault, timestamp);
  }
  bumpMarketInterval(context, intervals, { fill: { assets, discountBps: discount, fee, payToken } });
  writeCapacity(context, event, market, pool);
});

indexer.onEvent({ contract: "SelioMarket", event: "ReceiptRedeemed" }, async ({ event, context }) => {
  const { holder, to, assets } = event.params;
  const timestamp = event.block.timestamp;
  const [market, accounts, intervals] = await Promise.all([
    loadMarket(context, timestamp),
    loadAccounts(context, [holder], timestamp),
    loadMarketIntervals(context, timestamp),
  ]);

  context.Redemption.set({
    id: logId(event.block.number, event.logIndex),
    market_id: market.id,
    holder_id: holder,
    to,
    assets,
    bySelioVault: isSelioVault(holder),
    timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
  saveRows(context.Account, accounts);
  market.redeemedAssets += assets;
  market.updatedAt = timestamp;
  context.Market.set(market);
  bumpMarketInterval(context, intervals, { redeemedAssets: assets });
});
