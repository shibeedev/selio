import { describe, expect, it } from "vitest";
import { createTestIndexer, type Address } from "envio";
import { DEPLOYMENT } from "./deployment";
import {
  accountTokenId,
  bidEntityId,
  borrowPositionId,
  bucketId,
  dayStart,
  feeTotalId,
  hourStart,
  logId,
  sessionEntityId,
} from "./lib/ids";
import { missing } from "./lib/state";

const SELLER: Address = "0x5e11e50000000000000000000000000000000001";
const BIDDER: Address = "0xb1dde50000000000000000000000000000000002";
const BORROWER: Address = "0xb0bb0e0000000000000000000000000000000003";
const OTHER: Address = "0x07e0e50000000000000000000000000000000004";
const USDC = DEPLOYMENT.underlying;
const AUSD = DEPLOYMENT.collateral;
const MARKET = DEPLOYMENT.market;

// Example time of E.1: hour 1_791_871_200, day 1_791_849_600.
const T0 = 1_791_872_663;
/** Block `n` after the deployment, `n` seconds after T0. */
const block = (n: number) => ({ number: DEPLOYMENT.deployBlock + n, timestamp: T0 + n });
const txHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const tx = (n: number, from: Address = SELLER) => ({ hash: txHash(n), from });
const at = (n: number, logIndex = 0, from: Address = SELLER) => ({ block: block(n), transaction: tx(n, from), logIndex });

const usdcBid = (bidId: bigint, n: number, minDiscountBps: bigint, maxAssets: bigint, escrow: bigint, bidder = BIDDER) =>
  ({
    contract: "SelioMarket",
    event: "BidPlaced",
    srcAddress: MARKET,
    ...at(n, 0, bidder),
    params: { bidId, bidder, minDiscountBps, payToken: USDC, maxAssets, escrow },
  }) as const;

const schedule = { startBps: 50n, stepBps: 25n, stepInterval: 900n, capBps: 500n, duration: 86_400n, payMask: 3n };
const openSession = (sessionId: bigint, n: number, assets: bigint) =>
  ({
    contract: "SelioMarket",
    event: "SessionOpened",
    srcAddress: MARKET,
    ...at(n),
    params: { sessionId, seller: SELLER, assets, units: assets - 1_000n, params: schedule },
  }) as const;

describe("SelioMarket", () => {
  it("1. SessionOpened creates the session, raises sessionAssets and writes both capacity points", async () => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { 10143: { simulate: [openSession(1n, 1, 500_000_000n)] } } });

    const session = await indexer.Session.getOrThrow(sessionEntityId(MARKET, 1n));
    expect(session).toMatchObject({
      market_id: MARKET,
      seller_id: SELLER,
      openedAssets: 500_000_000n,
      openedUnits: 499_999_000n,
      startBps: 50,
      stepBps: 25,
      stepInterval: 900,
      capBps: 500,
      duration: 86_400,
      payMask: 3,
      startedAt: T0 + 1,
      endsAt: T0 + 1 + 86_400,
      openedBlock: DEPLOYMENT.deployBlock + 1,
      openedTx: txHash(1),
      listedAssets: 500_000_000n,
      soldAssets: 0n,
    });
    const market = await indexer.Market.getOrThrow(MARKET);
    expect(market).toMatchObject({ sessionsOpened: 1, sessionAssets: 500_000_000n, receipt: DEPLOYMENT.earnVault });
    expect((await indexer.Account.getOrThrow(SELLER)).sessionsOpened).toBe(1);

    for (const [interval, start] of [
      ["HOUR", hourStart(T0 + 1)],
      ["DAY", dayStart(T0 + 1)],
    ] as const) {
      const point = await indexer.CapacityPoint.getOrThrow(bucketId(MARKET, interval, start));
      expect(point).toMatchObject({ interval, start, sessionAssets: 500_000_000n, blockNumber: DEPLOYMENT.deployBlock + 1 });
      const activity = await indexer.MarketInterval.getOrThrow(bucketId(MARKET, interval, start));
      expect(activity.sessionsOpened).toBe(1);
    }
  });

  it("2. BidPlaced in USDC has the exact capacity and raises bid depth from its discount up", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: { 10143: { simulate: [usdcBid(1n, 1, 500n, 1_200_000_000n, 950_000_000n)] } },
    });

    const bid = await indexer.Bid.getOrThrow(bidEntityId(MARKET, 1n));
    expect(bid).toMatchObject({
      status: "LIVE",
      payIsUnderlying: true,
      capacityAssets: 1_000_000_000n,
      capacityExact: true,
      maxAssets: 1_200_000_000n,
      escrow: 950_000_000n,
      placedTx: txHash(1),
    });
    const market = await indexer.Market.getOrThrow(MARKET);
    expect(market).toMatchObject({
      bidsPlaced: 1,
      liveBids: 1,
      inexactLiveBids: 0,
      bidAt100: 0n,
      bidAt300: 0n,
      bidAt500: 1_000_000_000n,
      bidAt1000: 1_000_000_000n,
      bidAt2000: 1_000_000_000n,
    });
    expect((await indexer.AccountToken.getOrThrow(accountTokenId(BIDDER, USDC))).escrowLive).toBe(950_000_000n);
    const point = await indexer.CapacityPoint.getOrThrow(bucketId(MARKET, "HOUR", hourStart(T0 + 1)));
    expect(point).toMatchObject({ bidAt500: 1_000_000_000n, bidCapacityExact: true });
  });

  it("3. BidPlaced in AUSD-sim counts at its full size and is flagged inexact", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            {
              contract: "SelioMarket",
              event: "BidPlaced",
              srcAddress: MARKET,
              ...at(1, 0, BIDDER),
              params: {
                bidId: 1n,
                bidder: BIDDER,
                minDiscountBps: 300n,
                payToken: AUSD,
                maxAssets: 700_000_000n,
                escrow: 650_000_000_000_000_000_000n,
              },
            },
          ],
        },
      },
    });

    const bid = await indexer.Bid.getOrThrow(bidEntityId(MARKET, 1n));
    expect(bid).toMatchObject({ payIsUnderlying: false, capacityAssets: 700_000_000n, capacityExact: false });
    expect((await indexer.Market.getOrThrow(MARKET)).inexactLiveBids).toBe(1);
    const point = await indexer.CapacityPoint.getOrThrow(bucketId(MARKET, "DAY", dayStart(T0 + 1)));
    expect(point).toMatchObject({ bidAt300: 700_000_000n, bidAt100: 0n, bidCapacityExact: false });
  });

  it("4. a sell-now BidFilled records the fee and the seller's net and shrinks the bid exactly", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            usdcBid(1n, 1, 500n, 2_000_000_000n, 1_900_000_000n),
            {
              contract: "SelioMarket",
              event: "BidFilled",
              srcAddress: MARKET,
              ...at(2, 4, SELLER),
              params: {
                bidId: 1n,
                sessionId: 0n,
                seller: SELLER,
                assets: 1_052_631_579n,
                paid: 1_000_000_000n,
                fee: 2_000_000n,
                discountBps: 500n,
              },
            },
          ],
        },
      },
    });

    const fill = await indexer.Fill.getOrThrow(logId(DEPLOYMENT.deployBlock + 2, 4));
    expect(fill).toMatchObject({
      kind: "SELL_NOW",
      session_id: undefined,
      sessionId: 0n,
      bid_id: bidEntityId(MARKET, 1n),
      seller_id: SELLER,
      buyer_id: BIDDER,
      buyerIsSelioVault: false,
      assets: 1_052_631_579n,
      paid: 1_000_000_000n,
      fee: 2_000_000n,
      sellerNet: 998_000_000n,
      payToken: USDC,
      discountBps: 500,
      txHash: txHash(2),
      txFrom: SELLER,
    });
    const bid = await indexer.Bid.getOrThrow(bidEntityId(MARKET, 1n));
    // 2,000 − 1,052.631579 left to buy; 1,900 − 1,000 of escrow, which buys 947.368421 at 5%.
    expect(bid).toMatchObject({
      maxAssets: 947_368_421n,
      escrow: 900_000_000n,
      capacityAssets: 947_368_421n,
      filledAssets: 1_052_631_579n,
      paidOut: 1_000_000_000n,
      fillCount: 1,
      lastFillTx: txHash(2),
    });
    expect(await indexer.AccountToken.getOrThrow(accountTokenId(SELLER, USDC))).toMatchObject({
      receivedNet: 998_000_000n,
      feesPaid: 2_000_000n,
    });
    expect(await indexer.AccountToken.getOrThrow(accountTokenId(BIDDER, USDC))).toMatchObject({
      paidAsBuyer: 1_000_000_000n,
      escrowLive: 900_000_000n,
    });
    expect(await indexer.FeeTotal.getOrThrow(feeTotalId(MARKET, USDC))).toMatchObject({
      fees: 2_000_000n,
      gross: 1_000_000_000n,
      sellerNet: 998_000_000n,
      fillCount: 1,
    });
    expect(await indexer.Market.getOrThrow(MARKET)).toMatchObject({
      fillCount: 1,
      bidFilledAssets: 1_052_631_579n,
      bidAt500: 947_368_421n,
    });
    expect((await indexer.Account.getOrThrow(SELLER)).soldAssets).toBe(1_052_631_579n);
    const activity = await indexer.MarketInterval.getOrThrow(bucketId(MARKET, "HOUR", hourStart(T0 + 2)));
    expect(activity).toMatchObject({ fillCount: 1, feesByToken: { [USDC]: "2000000" }, minDiscountBps: 500 });
  });

  it("5. a match BidFilled sells from the session at a value-weighted average discount", async () => {
    const indexer = createTestIndexer();
    const match = (n: number, assets: bigint, paid: bigint, fee: bigint, discountBps: bigint) =>
      ({
        contract: "SelioMarket",
        event: "BidFilled",
        srcAddress: MARKET,
        ...at(n, 0, OTHER),
        params: { bidId: 1n, sessionId: 1n, seller: SELLER, assets, paid, fee, discountBps },
      }) as const;
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            openSession(1n, 1, 1_000_000_000n),
            usdcBid(1n, 2, 300n, 2_000_000_000n, 1_000_000_000n),
            match(3, 400_000_000n, 388_000_000n, 776_000n, 300n),
            match(4, 100_000_000n, 95_000_000n, 190_000n, 500n),
          ],
        },
      },
    });

    const fill = await indexer.Fill.getOrThrow(logId(DEPLOYMENT.deployBlock + 3, 0));
    expect(fill).toMatchObject({ kind: "AUCTION_MATCH", session_id: sessionEntityId(MARKET, 1n), sellerNet: 387_224_000n });
    const session = await indexer.Session.getOrThrow(sessionEntityId(MARKET, 1n));
    // (400 × 300 + 100 × 500) / 500 = 340
    expect(session).toMatchObject({ soldAssets: 500_000_000n, fillCount: 2, avgDiscountBps: 340, listedAssets: 500_000_000n });
    expect((await indexer.Market.getOrThrow(MARKET)).sessionAssets).toBe(500_000_000n);
    // 517 USDC of escrow left buys 532.989690 at 3%.
    expect(await indexer.Bid.getOrThrow(bidEntityId(MARKET, 1n))).toMatchObject({
      escrow: 517_000_000n,
      maxAssets: 1_500_000_000n,
      capacityAssets: 532_989_690n,
    });
  });

  it("6. BidCancelled closes after a fill in the same transaction, cancels otherwise, and removes depth", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            usdcBid(1n, 1, 500n, 1_000_000_000n, 950_000_000n),
            usdcBid(2n, 2, 1_000n, 500_000_000n, 450_000_000n, OTHER),
            {
              contract: "SelioMarket",
              event: "BidFilled",
              srcAddress: MARKET,
              ...at(3, 0),
              params: {
                bidId: 1n,
                sessionId: 0n,
                seller: SELLER,
                assets: 1_000_000_000n,
                paid: 950_000_000n,
                fee: 1_900_000n,
                discountBps: 500n,
              },
            },
            {
              contract: "SelioMarket",
              event: "BidCancelled",
              srcAddress: MARKET,
              ...at(3, 1),
              params: { bidId: 1n, bidder: BIDDER, refunded: 0n },
            },
            {
              contract: "SelioMarket",
              event: "BidCancelled",
              srcAddress: MARKET,
              ...at(4, 0, OTHER),
              params: { bidId: 2n, bidder: OTHER, refunded: 450_000_000n },
            },
          ],
        },
      },
    });

    expect(await indexer.Bid.getOrThrow(bidEntityId(MARKET, 1n))).toMatchObject({
      status: "CLOSED_AFTER_FILL",
      refunded: 0n,
      capacityAssets: 0n,
      closedAt: T0 + 3,
    });
    expect(await indexer.Bid.getOrThrow(bidEntityId(MARKET, 2n))).toMatchObject({
      status: "CANCELLED",
      refunded: 450_000_000n,
      maxAssets: 0n,
      escrow: 0n,
    });
    expect(await indexer.Market.getOrThrow(MARKET)).toMatchObject({
      liveBids: 0,
      bidAt100: 0n,
      bidAt500: 0n,
      bidAt1000: 0n,
      bidAt2000: 0n,
    });
    expect((await indexer.AccountToken.getOrThrow(accountTokenId(BIDDER, USDC))).escrowLive).toBe(0n);
    expect((await indexer.AccountToken.getOrThrow(accountTokenId(OTHER, USDC))).escrowLive).toBe(0n);
  });

  it("7. BidResized records the resize and moves remaining size, depth and live escrow", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            usdcBid(1n, 1, 500n, 1_200_000_000n, 950_000_000n),
            {
              contract: "SelioMarket",
              event: "BidResized",
              srcAddress: MARKET,
              ...at(2, 0, BIDDER),
              params: { bidId: 1n, bidder: BIDDER, maxAssets: 600_000_000n, escrow: 475_000_000n },
            },
          ],
        },
      },
    });

    expect(await indexer.BidResize.getOrThrow(logId(DEPLOYMENT.deployBlock + 2, 0))).toMatchObject({
      bid_id: bidEntityId(MARKET, 1n),
      maxAssetsBefore: 1_200_000_000n,
      escrowBefore: 950_000_000n,
      maxAssets: 600_000_000n,
      escrow: 475_000_000n,
    });
    expect(await indexer.Bid.getOrThrow(bidEntityId(MARKET, 1n))).toMatchObject({
      maxAssetsPlaced: 1_200_000_000n,
      maxAssets: 600_000_000n,
      escrow: 475_000_000n,
      capacityAssets: 500_000_000n,
      resizeCount: 1,
    });
    expect((await indexer.Market.getOrThrow(MARKET)).bidAt500).toBe(500_000_000n);
    expect((await indexer.AccountToken.getOrThrow(accountTokenId(BIDDER, USDC))).escrowLive).toBe(475_000_000n);
  });

  it("8. Bought in wallet and flash mode records the kinds, the debt repaid and the borrower totals", async () => {
    const indexer = createTestIndexer();
    const bought = (n: number, mode: bigint, payToken: Address, assets: bigint, paid: bigint, fee: bigint) =>
      ({
        contract: "SelioMarket",
        event: "Bought",
        srcAddress: MARKET,
        ...at(n, 0, BORROWER),
        params: { sessionId: 1n, buyer: BORROWER, assets, debtRepaid: assets, discountBps: 150n, payToken, paid, fee, mode },
      }) as const;
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            openSession(1n, 1, 1_000_000_000n),
            bought(2, 0n, USDC, 200_000_000n, 197_000_000n, 394_000n),
            bought(3, 1n, AUSD, 100_000_000n, 98_500_000_000_000_000_000n, 197_000_000_000_000_000n),
          ],
        },
      },
    });

    expect(await indexer.Fill.getOrThrow(logId(DEPLOYMENT.deployBlock + 2, 0))).toMatchObject({
      kind: "BORROWER_WALLET",
      bid_id: undefined,
      bidId: undefined,
      seller_id: SELLER,
      buyer_id: BORROWER,
      debtRepaid: 200_000_000n,
      sellerNet: 196_606_000n,
    });
    expect((await indexer.Fill.getOrThrow(logId(DEPLOYMENT.deployBlock + 3, 0))).kind).toBe("BORROWER_COLLATERAL");
    expect(await indexer.Market.getOrThrow(MARKET)).toMatchObject({
      fillCount: 2,
      borrowerFilledAssets: 300_000_000n,
      bidFilledAssets: 0n,
      debtRepaid: 300_000_000n,
      sessionAssets: 700_000_000n,
    });
    expect(await indexer.Account.getOrThrow(BORROWER)).toMatchObject({
      boughtAssets: 300_000_000n,
      debtRepaid: 300_000_000n,
    });
    expect((await indexer.AccountToken.getOrThrow(accountTokenId(BORROWER, AUSD))).paidAsBuyer).toBe(
      98_500_000_000_000_000_000n,
    );
    expect((await indexer.FeeTotal.getOrThrow(feeTotalId(MARKET, AUSD))).fees).toBe(197_000_000_000_000_000n);
    const activity = await indexer.MarketInterval.getOrThrow(bucketId(MARKET, "DAY", dayStart(T0)));
    expect(activity).toMatchObject({
      borrowerFilledAssets: 300_000_000n,
      debtRepaid: 300_000_000n,
      feesByToken: { [USDC]: "394000", [AUSD]: "197000000000000000" },
    });
  });

  it("14. a BidFilled for a bid the index has never seen stops the indexer", async () => {
    const indexer = createTestIndexer();
    const id = bidEntityId(MARKET, 9n);
    await expect(
      indexer.process({
        chains: {
          10143: {
            simulate: [
              {
                contract: "SelioMarket",
                event: "BidFilled",
                srcAddress: MARKET,
                ...at(1),
                params: { bidId: 9n, sessionId: 0n, seller: SELLER, assets: 1n, paid: 1n, fee: 0n, discountBps: 100n },
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(missing("Bid", id));
  });
});

describe("SelioVault", () => {
  it("9. a vault bid fill then a recovery give the bought figures and both recovery rates", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            usdcBid(1n, 1, 300n, 2_000_000_000n, 1_940_000_000n, DEPLOYMENT.selioVault),
            {
              contract: "SelioMarket",
              event: "BidFilled",
              srcAddress: MARKET,
              ...at(2),
              params: {
                bidId: 1n,
                sessionId: 0n,
                seller: SELLER,
                assets: 1_000_000_000n,
                paid: 970_000_000n,
                fee: 1_940_000n,
                discountBps: 300n,
              },
            },
            {
              contract: "SelioVault",
              event: "Recovered",
              srcAddress: DEPLOYMENT.selioVault,
              ...at(3, 0, OTHER),
              params: { strategy: 0n, caller: OTHER, assets: 1_000_000_000n },
            },
          ],
        },
      },
    });

    const vault = await indexer.SelioVaultState.getOrThrow(DEPLOYMENT.selioVault);
    expect(vault).toMatchObject({
      boughtAssets: 1_000_000_000n,
      boughtCost: 970_000_000n,
      boughtFills: 1,
      recoveredAssets: 1_000_000_000n,
      recoveryRateBps: 10_000,
      costRecoveryBps: 10_309,
      liveBid_id: bidEntityId(MARKET, 1n),
    });
    expect((await indexer.Fill.getOrThrow(logId(DEPLOYMENT.deployBlock + 2, 0))).buyerIsSelioVault).toBe(true);
    expect(await indexer.VaultAction.getOrThrow(logId(DEPLOYMENT.deployBlock + 3, 0))).toMatchObject({
      kind: "RECOVER",
      account_id: OTHER,
      assets: 1_000_000_000n,
      strategy: 0,
    });
    const day = await indexer.VaultInterval.getOrThrow(bucketId(DEPLOYMENT.selioVault, "DAY", dayStart(T0)));
    expect(day).toMatchObject({ boughtAssets: 1_000_000_000n, boughtCost: 970_000_000n, recoveredAssets: 1_000_000_000n });
  });

  it("15. the base-yield events track the source shares, the pull-back and the in-kind payout", async () => {
    const indexer = createTestIndexer();
    const vault = DEPLOYMENT.selioVault;
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            // A refresh moves cash to or from the source before it reports the vault's totals.
            {
              contract: "SelioVault",
              event: "SourceDeposited",
              srcAddress: vault,
              ...at(1),
              params: { assets: 800_000_000n, shares: 790_000_000n },
            },
            {
              contract: "SelioVault",
              event: "BidsRefreshed",
              srcAddress: vault,
              ...at(1, 1),
              params: { totalAssets: 1_000_000_000n, idle: 200_000_000n },
            },
            {
              contract: "SelioVault",
              event: "SourceWithdrawn",
              srcAddress: vault,
              ...at(2),
              params: { assets: 100_000_000n, shares: 98_000_000n },
            },
            {
              contract: "SelioVault",
              event: "BidsRefreshed",
              srcAddress: vault,
              ...at(2, 1),
              params: { totalAssets: 1_000_000_000n, idle: 300_000_000n },
            },
            {
              contract: "SelioVault",
              event: "SourcePulled",
              srcAddress: vault,
              ...at(3, 0, OTHER),
              params: { assets: 300_000_000n, shares: 296_000_000n, utilizationBps: 9_420n },
            },
            {
              contract: "SelioVault",
              event: "SourceSharesInKind",
              srcAddress: vault,
              ...at(4, 0, OTHER),
              params: { receiver: OTHER, shares: 96_000_000n },
            },
          ],
        },
      },
    });

    // The pull-back adds its 300 USDC to idle; the total is unchanged until the next refresh reports it.
    expect(await indexer.SelioVaultState.getOrThrow(vault)).toMatchObject({
      totalAssets: 1_000_000_000n,
      idle: 600_000_000n,
      sourceShares: 300_000_000n,
      sourceDepositedAssets: 800_000_000n,
      sourceWithdrawnAssets: 100_000_000n,
      sourcePulledAssets: 300_000_000n,
      sourceSharesInKind: 96_000_000n,
      lastPullUtilizationBps: 9_420,
    });
    expect(await indexer.VaultAction.getOrThrow(logId(DEPLOYMENT.deployBlock + 3, 0))).toMatchObject({
      kind: "SOURCE_PULL",
      account_id: vault,
      utilizationBps: 9_420,
    });
    expect(await indexer.VaultAction.getOrThrow(logId(DEPLOYMENT.deployBlock + 4, 0))).toMatchObject({
      kind: "SOURCE_IN_KIND",
      account_id: OTHER,
      receiver: OTHER,
      shares: 96_000_000n,
    });
    const hour = await indexer.VaultInterval.getOrThrow(bucketId(vault, "HOUR", hourStart(T0)));
    expect(hour.sourceShares).toBe(300_000_000n);
  });
});

describe("protected pool", () => {
  it("10. Earn vault flows move idle and total assets as E.6 says", async () => {
    const indexer = createTestIndexer();
    const earn = DEPLOYMENT.earnVault;
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            {
              contract: "EarnVault",
              event: "Deposit",
              srcAddress: earn,
              ...at(1, 0, OTHER),
              params: { sender: OTHER, onBehalf: OTHER, assets: 1_000_000_000n, shares: 1_000_000_000_000_000_000_000n },
            },
            {
              contract: "EarnVault",
              event: "Allocate",
              srcAddress: earn,
              ...at(1, 1, OTHER),
              params: { sender: OTHER, adapter: DEPLOYMENT.adapter, assets: 900_000_000n },
            },
            {
              contract: "EarnVault",
              event: "Withdraw",
              srcAddress: earn,
              ...at(2, 0, OTHER),
              params: { sender: OTHER, receiver: OTHER, onBehalf: OTHER, assets: 50_000_000n, shares: 1n },
            },
            {
              contract: "EarnVault",
              event: "Deallocate",
              srcAddress: earn,
              ...at(3, 0),
              params: { sender: MARKET, adapter: DEPLOYMENT.adapter, assets: 200_000_000n },
            },
            {
              contract: "EarnVault",
              event: "Withdraw",
              srcAddress: earn,
              ...at(3, 1),
              params: { sender: MARKET, receiver: earn, onBehalf: MARKET, assets: 2_000n, shares: 1n },
            },
            {
              contract: "EarnVault",
              event: "ForceDeallocate",
              srcAddress: earn,
              ...at(3, 2),
              params: { sender: MARKET, adapter: DEPLOYMENT.adapter, assets: 200_000_000n, onBehalf: MARKET, penaltyAssets: 2_000n },
            },
            {
              contract: "EarnVault",
              event: "AccrueInterest",
              srcAddress: earn,
              ...at(4, 0),
              params: { previousTotalAssets: 949_998_000n, newTotalAssets: 960_000_000n },
            },
          ],
        },
      },
    });

    expect(await indexer.EarnVaultState.getOrThrow(earn)).toMatchObject({
      idle: 250_000_000n,
      totalAssets: 960_000_000n,
      depositedAssets: 1_000_000_000n,
      withdrawnAssets: 50_002_000n,
      penaltyAssets: 2_000n,
    });
    const kinds = (await indexer.PoolEvent.getAll()).map((row) => row.kind).sort();
    expect(kinds).toEqual([
      "VAULT_ALLOCATE",
      "VAULT_DEALLOCATE",
      "VAULT_DEPOSIT",
      "VAULT_FORCE_DEALLOCATE",
      "VAULT_WITHDRAW",
      "VAULT_WITHDRAW",
    ]);
    // Only idle cash is withdrawable: (960 − 250) / 960 = 7395 bps.
    expect(await indexer.CapacityPoint.getOrThrow(bucketId(MARKET, "HOUR", hourStart(T0)))).toMatchObject({
      withdrawable: 250_000_000n,
      supplied: 960_000_000n,
      utilizationBps: 7_395,
      blockNumber: DEPLOYMENT.deployBlock + 4,
    });
  });

  it("11. Morpho supply, borrow, repay, interest and a bad-debt liquidation give E.7 totals and the E.8 point", async () => {
    const indexer = createTestIndexer();
    const id = DEPLOYMENT.earnMarketId;
    const onMorpho = (n: number) => ({ srcAddress: DEPLOYMENT.morpho, ...at(n) });
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            {
              contract: "EarnVault",
              event: "Deposit",
              srcAddress: DEPLOYMENT.earnVault,
              ...at(1, 0, OTHER),
              params: { sender: OTHER, onBehalf: OTHER, assets: 1_000_000_000n, shares: 1n },
            },
            {
              contract: "EarnVault",
              event: "Allocate",
              srcAddress: DEPLOYMENT.earnVault,
              ...at(1, 1, OTHER),
              params: { sender: OTHER, adapter: DEPLOYMENT.adapter, assets: 1_000_000_000n },
            },
            {
              contract: "Morpho",
              event: "Supply",
              ...onMorpho(2),
              params: { id, caller: DEPLOYMENT.adapter, onBehalf: DEPLOYMENT.adapter, assets: 1_000_000_000n, shares: 10n ** 15n },
            },
            {
              contract: "Morpho",
              event: "Borrow",
              ...onMorpho(3),
              params: { id, caller: OTHER, onBehalf: OTHER, receiver: OTHER, assets: 100_000_000n, shares: 10n ** 14n },
            },
            // Repaying the whole market debt may report 1 more asset than the total.
            {
              contract: "Morpho",
              event: "Repay",
              ...onMorpho(4),
              params: { id, caller: OTHER, onBehalf: OTHER, assets: 100_000_001n, shares: 10n ** 14n },
            },
            {
              contract: "Morpho",
              event: "Borrow",
              ...onMorpho(5),
              params: { id, caller: BORROWER, onBehalf: BORROWER, receiver: BORROWER, assets: 600_000_000n, shares: 6n * 10n ** 14n },
            },
            {
              contract: "Morpho",
              event: "Borrow",
              ...onMorpho(6),
              params: { id, caller: OTHER, onBehalf: OTHER, receiver: OTHER, assets: 200_000_000n, shares: 2n * 10n ** 14n },
            },
            {
              contract: "Morpho",
              event: "AccrueInterest",
              ...onMorpho(7),
              params: { id, prevBorrowRate: 1n, interest: 40_000_000n, feeShares: 0n },
            },
            {
              contract: "Morpho",
              event: "SupplyCollateral",
              ...onMorpho(8),
              params: { id, caller: OTHER, onBehalf: OTHER, assets: 10n ** 21n },
            },
            {
              contract: "Morpho",
              event: "Liquidate",
              ...onMorpho(9),
              params: {
                id,
                caller: BIDDER,
                borrower: OTHER,
                repaidAssets: 150_000_000n,
                repaidShares: 15n * 10n ** 13n,
                seizedAssets: 2n * 10n ** 20n,
                badDebtAssets: 60_000_000n,
                badDebtShares: 5n * 10n ** 13n,
              },
            },
          ],
        },
      },
    });

    expect(await indexer.MorphoMarket.getOrThrow(id)).toMatchObject({
      role: "EARN",
      totalSupplyAssets: 980_000_000n,
      totalSupplyShares: 10n ** 15n,
      totalBorrowAssets: 630_000_000n,
      totalBorrowShares: 6n * 10n ** 14n,
      adapterSupplyShares: 10n ** 15n,
    });
    expect(await indexer.BorrowPosition.getOrThrow(borrowPositionId(id, OTHER))).toMatchObject({
      borrowShares: 0n,
      collateral: 8n * 10n ** 20n,
    });
    expect((await indexer.BorrowPosition.getOrThrow(borrowPositionId(id, BORROWER))).borrowShares).toBe(6n * 10n ** 14n);
    // The adapter's 980 USDC is capped by 350 USDC of free liquidity; nothing is idle.
    expect(await indexer.CapacityPoint.getOrThrow(bucketId(MARKET, "DAY", dayStart(T0)))).toMatchObject({
      withdrawable: 350_000_000n,
      supplied: 1_000_000_000n,
      utilizationBps: 6_500,
      debtorCapacity: 630_000_000n,
      blockNumber: DEPLOYMENT.deployBlock + 9,
    });
  });

  it("12. a Morpho event of another market writes nothing", async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({
      chains: {
        10143: {
          simulate: [
            {
              contract: "Morpho",
              event: "Supply",
              srcAddress: DEPLOYMENT.morpho,
              ...at(1),
              params: { id: `0x${"ab".repeat(32)}`, caller: OTHER, onBehalf: OTHER, assets: 5n, shares: 5n },
            },
          ],
        },
      },
    });

    expect(result.changes.flatMap((change) => Object.keys(change).filter((key) => /^[A-Z]/.test(key)))).toEqual([]);
    expect(await indexer.MorphoMarket.getAll()).toEqual([]);
    expect(await indexer.PoolEvent.getAll()).toEqual([]);
    expect(await indexer.Account.getAll()).toEqual([]);
  });

  it("13. both Transfer streams move receipt and vault shares and the supplies", async () => {
    const indexer = createTestIndexer();
    const zero: Address = "0x0000000000000000000000000000000000000000";
    await indexer.process({
      chains: {
        10143: {
          simulate: [
            { contract: "SelioVault", event: "Transfer", srcAddress: DEPLOYMENT.selioVault, ...at(1), params: { from: zero, to: SELLER, value: 1_000n } },
            { contract: "SelioVault", event: "Transfer", srcAddress: DEPLOYMENT.selioVault, ...at(2), params: { from: SELLER, to: OTHER, value: 300n } },
            { contract: "SelioVault", event: "Transfer", srcAddress: DEPLOYMENT.selioVault, ...at(3), params: { from: OTHER, to: zero, value: 100n } },
            { contract: "EarnVault", event: "Transfer", srcAddress: DEPLOYMENT.earnVault, ...at(4), params: { from: zero, to: SELLER, shares: 5_000n } },
            { contract: "EarnVault", event: "Transfer", srcAddress: DEPLOYMENT.earnVault, ...at(5), params: { from: SELLER, to: MARKET, shares: 2_000n } },
          ],
        },
      },
    });

    expect(await indexer.Account.getOrThrow(SELLER)).toMatchObject({ vaultShares: 700n, receiptShares: 3_000n });
    expect((await indexer.Account.getOrThrow(OTHER)).vaultShares).toBe(200n);
    expect((await indexer.Account.getOrThrow(MARKET)).receiptShares).toBe(2_000n);
    expect(await indexer.Account.get(zero)).toBeUndefined();
    expect((await indexer.SelioVaultState.getOrThrow(DEPLOYMENT.selioVault)).totalSupply).toBe(900n);
    expect((await indexer.EarnVaultState.getOrThrow(DEPLOYMENT.earnVault)).totalSupply).toBe(5_000n);
  });
});
