import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Address } from "viem";
import type { Deployment } from "@selio/sdk";
import { AAVE_DEPLOYMENT, ADDR, MORPHO_DEPLOYMENT, fakeChain, fakeNetwork } from "../testing/fakes.js";
import { listen } from "../testing/rpc-stub.js";
import {
  HISTORY_LAG_OK_BLOCKS,
  HISTORY_MAX_LIMIT,
  getHistory,
  getHistoryShape,
  type AuctionItem,
  type BidItem,
  type CapacityItem,
  type FillItem,
  type VaultItem,
} from "./history.js";

const TESTNET: Deployment = { ...MORPHO_DEPLOYMENT, network: "monad-testnet", chainId: 10143 };
// The index stores addresses in lowercase.
const lc = (a: Address) => a.toLowerCase();
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const NOW = 1_791_872_663;
const TX = `0x${"ab".repeat(32)}`;
const META = {
  chainId: 10143,
  progressBlock: 70_610_000,
  sourceBlock: 70_610_010,
  isReady: true,
  readyAt: "2026-10-13T08:00:00+00:00",
};

const DISPLAY_ONLY_NOTE =
  "History comes from the Selio event index (Envio HyperIndex) of monad-testnet and is for display only. Exit capacity, prices and every transaction must come from on-chain reads: use get_exit_capacity, list_sessions, list_bids or quote_purchase before building a transaction.";
const RECONSTRUCTED_NOTE =
  "Capacity points are reconstructed from events: they leave out interest not yet accrued on-chain and USDC sent to the Earn vault directly, and bids paying in a token other than the underlying count at their full remaining size (bidCapacityExact is then false).";
const usdc = (raw: string, human: string) => ({ raw, human, symbol: "USDC" });

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

let closeIndexer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeIndexer?.();
  closeIndexer = undefined;
});

/** A GraphQL endpoint standing in for the Selio indexer; `reply` answers each request. */
async function indexer(reply: (request: GraphqlRequest) => { status?: number; body: unknown }) {
  const requests: GraphqlRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const request = JSON.parse(raw) as GraphqlRequest;
      requests.push(request);
      const { status = 200, body } = reply(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  const endpoint = await listen(server);
  closeIndexer = endpoint.close;
  return { url: `${endpoint.url}/v1/graphql`, requests };
}

/** An index answer for the testnet market: the index head plus `data`. */
const answer = (data: Record<string, unknown>, head: Record<string, unknown> = {}) => ({
  body: { data: { _meta: [META], market: { id: lc(TESTNET.market), updatedAt: 1 }, ...head, ...data } },
});

/** The monad-testnet deployment, its chain head at the index's block, and an MCP context pointing at `url`. */
function testnet(url: string | undefined) {
  const net = fakeNetwork(TESTNET);
  net.reads.blockNumber.mockResolvedValue(BigInt(META.progressBlock));
  const ctx = { chain: fakeChain({ "monad-testnet": net.handle }), indexerUrl: url, nowSeconds: () => BigInt(NOW) };
  return { net, ctx };
}

function fill(overrides: Record<string, unknown> = {}) {
  return {
    kind: "SELL_NOW",
    sessionId: "0",
    bidId: "4",
    seller: { id: lc(ADDR.seller) },
    buyer: { id: lc(TESTNET.selioVault) },
    buyerIsSelioVault: true,
    assets: "1000000000",
    paid: "950000000",
    fee: "1900000",
    sellerNet: "948100000",
    payToken: lc(ADDR.morphoUSDC),
    discountBps: 500,
    debtRepaid: null,
    timestamp: NOW,
    blockNumber: 70_609_990,
    logIndex: 2,
    txHash: TX,
    txFrom: lc(ADDR.seller),
    ...overrides,
  };
}

describe("get_history input", () => {
  const schema = z.object(getHistoryShape);
  const base = { network: "monad-testnet", view: "fills" };

  it("accepts the six views and bounds sinceHours, limit and cursor", () => {
    for (const view of ["fills", "auctions", "bids", "capacity", "vault", "wallet"]) {
      expect(schema.safeParse({ ...base, view }).success).toBe(true);
    }
    expect(schema.safeParse({ ...base, view: "prices" }).success).toBe(false);
    expect(schema.safeParse({ ...base, sinceHours: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, sinceHours: 8761 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, limit: HISTORY_MAX_LIMIT + 1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, cursor: "-1" }).success).toBe(false);
    expect(schema.safeParse({ ...base, address: "0x1234" }).success).toBe(false);
  });
});

describe("get_history refusals", () => {
  it("refuses the scenario forks, a server without an indexer, and the wallet view without an address", async () => {
    const aave = fakeNetwork(AAVE_DEPLOYMENT);
    const fork = { chain: fakeChain({ "usdt0-replay": aave.handle }), indexerUrl: "http://127.0.0.1:9/v1/graphql" };
    await expect(getHistory(fork, { network: "usdt0-replay", view: "fills" })).rejects.toThrow(
      "History is indexed on monad-testnet only. usdt0-replay and vault-freeze are scenario forks reset every day; use list_sessions, list_bids and get_exit_capacity for their current state.",
    );
    const { ctx } = testnet(undefined);
    await expect(getHistory(ctx, { network: "monad-testnet", view: "fills" })).rejects.toThrow(
      "This MCP server has no Selio indexer configured (SELIO_INDEXER_URL, or INDEXER_URL on the hosted server).",
    );
    await expect(getHistory(ctx, { network: "monad-testnet", view: "wallet" })).rejects.toThrow(
      'view "wallet" needs an address.',
    );
  });

  it("refuses a market the index does not cover", async () => {
    const { url } = await indexer(() => answer({ fills: [], fees: [] }, { market: null }));
    const { ctx } = testnet(url);
    await expect(getHistory(ctx, { network: "monad-testnet", view: "fills" })).rejects.toThrow(
      `The Selio indexer does not cover the monad-testnet market ${TESTNET.market}; it may still index an earlier deployment.`,
    );
  });

  it("reports an unreachable indexer, a rate limit and a GraphQL error as tool errors", async () => {
    const gone = await listen(createServer());
    await gone.close();
    const down = testnet(`${gone.url}/v1/graphql`);
    await expect(getHistory(down.ctx, { network: "monad-testnet", view: "fills" })).rejects.toThrow(
      /^The Selio indexer did not answer: The Selio indexer could not be reached: .+\. Try again shortly\.$/,
    );

    let reply: { status?: number; body: unknown } = { status: 429, body: {} };
    const { url } = await indexer(() => reply);
    const { ctx } = testnet(url);
    await expect(getHistory(ctx, { network: "monad-testnet", view: "fills" })).rejects.toThrow(
      /^The Selio indexer did not answer: The Selio indexer is rate-limiting requests; try again shortly\.$/,
    );
    reply = { body: { errors: [{ message: "field 'Fill' not found in type: 'query_root'" }] } };
    await expect(getHistory(ctx, { network: "monad-testnet", view: "fills" })).rejects.toThrow(
      /^The Selio indexer did not answer: field 'Fill' not found in type: 'query_root'$/,
    );
  });
});

describe("get_history views", () => {
  it("returns fills with the fee and what the seller received, filtered by wallet", async () => {
    const { url, requests } = await indexer(() => answer({ fills: [fill()], fees: [] }));
    const { ctx } = testnet(url);
    const res = await getHistory(ctx, { network: "monad-testnet", view: "fills", address: lc(ADDR.seller) });
    expect(requests[0]?.variables).toEqual({
      market: lc(TESTNET.market),
      since: 0,
      limit: 20,
      offset: 0,
      account: lc(ADDR.seller),
    });
    expect(res.items as FillItem[]).toEqual([
      {
        kind: "SELL_NOW",
        sessionId: "0",
        bidId: "4",
        seller: ADDR.seller,
        buyer: TESTNET.selioVault,
        buyerIsSelioVault: true,
        receiptValue: usdc("1000000000", "1000"),
        paid: usdc("950000000", "950"),
        fee: usdc("1900000", "1.9"),
        sellerReceived: usdc("948100000", "948.1"),
        discount: { bps: 500, percent: "5.00%" },
        debtRepaid: null,
        time: "2026-10-13T06:24:23.000Z",
        block: 70_609_990,
        txHash: TX,
      },
    ]);
    expect(res).toMatchObject({ network: "monad-testnet", view: "fills", market: TESTNET.market });
    expect(res.index).toEqual({
      source: "Envio HyperIndex",
      indexedToBlock: META.progressBlock,
      chainHead: META.progressBlock,
      lagBlocks: 0,
      ready: true,
    });
    expect(res.notes).toEqual([DISPLAY_ONLY_NOTE]);
    expect(res).not.toHaveProperty("nextCursor");
    expect(res).not.toHaveProperty("account");
  });

  it("gives a nextCursor after a full page and reads the next page from it", async () => {
    const { url, requests } = await indexer(({ variables }) =>
      answer({
        fills: variables.offset === 0 ? [fill({ logIndex: 2 }), fill({ logIndex: 1 })] : [fill({ logIndex: 0 })],
        fees: [],
      }),
    );
    const { ctx } = testnet(url);
    const first = await getHistory(ctx, { network: "monad-testnet", view: "fills", limit: 2, sinceHours: 24 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    const second = await getHistory(ctx, { network: "monad-testnet", view: "fills", limit: 2, cursor: first.nextCursor });
    expect(requests.map((r) => [r.variables.since, r.variables.limit, r.variables.offset])).toEqual([
      [NOW - 24 * 3600, 2, 0],
      [0, 2, 2],
    ]);
    expect(second.items).toHaveLength(1);
    expect(second).not.toHaveProperty("nextCursor");
  });

  it("returns capacity in hourly buckets over 168 hours by default, the point before the window first, with notes 1 and 3", async () => {
    const point = (start: number, withdrawable: string) => ({
      interval: "HOUR",
      start,
      updatedAt: start + 120,
      blockNumber: 70_600_000,
      withdrawable,
      supplied: "3000000",
      utilizationBps: 6666,
      debtorCapacity: "2000000",
      sessionAssets: "0",
      bidAt100: "0",
      bidAt300: "0",
      bidAt500: "1000000",
      bidAt1000: "1000000",
      bidAt2000: "1500000",
      bidCapacityExact: false,
    });
    const hour = 1_791_871_200;
    const { url, requests } = await indexer(() =>
      answer({ seed: [point(hour - 200 * 3600, "0")], points: [point(hour - 3600, "1000000"), point(hour, "2000000")] }),
    );
    const { ctx } = testnet(url);
    const res = await getHistory(ctx, { network: "monad-testnet", view: "capacity" });
    expect(requests[0]?.query).toContain('interval: {_eq: "HOUR"}, start: {_gte: $since}');
    expect(requests[0]?.variables).toEqual({ market: lc(TESTNET.market), since: NOW - 168 * 3600, limit: 1_000 });
    const items = res.items as CapacityItem[];
    expect(items.map((i) => [i.time, i.withdrawable.human])).toEqual([
      [iso(hour - 200 * 3600), "0"],
      [iso(hour - 3600), "1"],
      [iso(hour), "2"],
    ]);
    expect(items[1]).toEqual({
      time: iso(hour - 3600),
      interval: "hour",
      withdrawable: usdc("1000000", "1"),
      supplied: usdc("3000000", "3"),
      utilization: { bps: 6666, percent: "66.66%" },
      debtorCapacity: usdc("2000000", "2"),
      sessionAssets: usdc("0", "0"),
      bidCapacity: [
        { maxDiscount: { bps: 100, percent: "1.00%" }, assets: usdc("0", "0") },
        { maxDiscount: { bps: 300, percent: "3.00%" }, assets: usdc("0", "0") },
        { maxDiscount: { bps: 500, percent: "5.00%" }, assets: usdc("1000000", "1") },
        { maxDiscount: { bps: 1_000, percent: "10.00%" }, assets: usdc("1000000", "1") },
        { maxDiscount: { bps: 2_000, percent: "20.00%" }, assets: usdc("1500000", "1.5") },
      ],
      bidCapacityExact: false,
    });
    expect(res.notes).toEqual([DISPLAY_ONLY_NOTE, RECONSTRUCTED_NOTE]);

    await getHistory(ctx, { network: "monad-testnet", view: "capacity", sinceHours: 720 });
    expect(requests[1]?.query).toContain('interval: {_eq: "DAY"}');
    expect(requests[1]?.variables).toMatchObject({ since: NOW - 720 * 3600 });
  });

  it("adds the lag note when the index is behind the chain or still syncing, and leaves the lag unknown without a head", async () => {
    let meta: Record<string, unknown> = META;
    const { url } = await indexer(() => answer({ fills: [], fees: [] }, { _meta: [meta] }));
    const { net, ctx } = testnet(url);
    const args = { network: "monad-testnet", view: "fills" } as const;
    const lagNote = `The index is behind the chain: activity after block ${META.progressBlock} is not included yet.`;

    net.reads.blockNumber.mockResolvedValue(BigInt(META.progressBlock + HISTORY_LAG_OK_BLOCKS + 1));
    const behind = await getHistory(ctx, args);
    expect(behind.index).toMatchObject({ chainHead: META.progressBlock + 51, lagBlocks: 51, ready: true });
    expect(behind.notes).toEqual([DISPLAY_ONLY_NOTE, lagNote]);

    net.reads.blockNumber.mockResolvedValue(BigInt(META.progressBlock + HISTORY_LAG_OK_BLOCKS));
    expect((await getHistory(ctx, args)).notes).toEqual([DISPLAY_ONLY_NOTE]);

    net.reads.blockNumber.mockRejectedValue(new Error("RPC unavailable"));
    const headless = await getHistory(ctx, args);
    expect(headless.index).toMatchObject({ indexedToBlock: META.progressBlock, chainHead: null, lagBlocks: null });
    expect(headless.notes).toEqual([DISPLAY_ONLY_NOTE]);

    meta = { ...META, isReady: false, readyAt: null };
    const syncing = await getHistory(ctx, args);
    expect(syncing.index.ready).toBe(false);
    expect(syncing.notes).toEqual([DISPLAY_ONLY_NOTE, lagNote]);
  });

  it("returns auctions with their schedule, amounts and fills", async () => {
    const session = {
      sessionId: "3",
      seller: { id: lc(ADDR.seller) },
      startedAt: 1_791_849_600,
      endsAt: 1_791_936_000,
      startBps: 50,
      stepBps: 25,
      stepInterval: 900,
      capBps: 500,
      openedAssets: "5000000000",
      soldAssets: "1000000000",
      withdrawnAssets: "0",
      listedAssets: "4000000000",
      fillCount: 1,
      avgDiscountBps: 75,
      fills: [{ timestamp: 1_791_851_400, discountBps: 75, assets: "1000000000", kind: "AUCTION_MATCH" }],
    };
    const { url, requests } = await indexer(() => answer({ sessions: [session] }));
    const { ctx } = testnet(url);
    const res = await getHistory(ctx, { network: "monad-testnet", view: "auctions", address: ADDR.seller, sinceHours: 24 });
    expect(requests[0]?.variables).toEqual({
      market: lc(TESTNET.market),
      since: NOW - 24 * 3600,
      limit: 20,
      offset: 0,
      seller: lc(ADDR.seller),
    });
    expect(res.items as AuctionItem[]).toEqual([
      {
        sessionId: "3",
        seller: ADDR.seller,
        startedAt: iso(1_791_849_600),
        endsAt: iso(1_791_936_000),
        schedule: {
          start: { bps: 50, percent: "0.50%" },
          step: { bps: 25, percent: "0.25%" },
          stepIntervalSeconds: 900,
          cap: { bps: 500, percent: "5.00%" },
        },
        opened: usdc("5000000000", "5000"),
        sold: usdc("1000000000", "1000"),
        withdrawn: usdc("0", "0"),
        averageDiscount: { bps: 75, percent: "0.75%" },
        fills: [{ time: iso(1_791_851_400), discount: { bps: 75, percent: "0.75%" }, receiptValue: usdc("1000000000", "1000") }],
      },
    ]);
  });

  it("returns bids with their placed and remaining sizes and status, paged from the market's latest bids", async () => {
    const bid = (bidId: string, overrides: Record<string, unknown>) => ({
      bidId,
      bidder: { id: lc(ADDR.bidder) },
      isSelioVault: false,
      maxAssetsPlaced: "1200000000",
      escrowPlaced: "950000000",
      maxAssets: "200000000",
      escrow: "0",
      filledAssets: "1000000000",
      paidOut: "950000000",
      status: "CLOSED_AFTER_FILL",
      placedAt: 1_791_000_000,
      closedAt: 1_791_100_000,
      payToken: lc(ADDR.morphoUSDC),
      minDiscountBps: 300,
      ...overrides,
    });
    const bids = [
      bid("7", {}),
      bid("6", { status: "LIVE", closedAt: null, payToken: lc(ADDR.morphoWETH), escrowPlaced: "400000000000000000" }),
      bid("5", { status: "CANCELLED" }),
    ];
    const { url, requests } = await indexer(() => answer({ bids }));
    const { ctx } = testnet(url);
    const first = await getHistory(ctx, { network: "monad-testnet", view: "bids", limit: 2 });
    expect(requests[0]?.variables).toEqual({ market: lc(TESTNET.market) });
    const items = first.items as BidItem[];
    expect(items[0]).toEqual({
      bidId: "7",
      bidder: ADDR.bidder,
      isSelioVault: false,
      minDiscount: { bps: 300, percent: "3.00%" },
      payToken: { symbol: "USDC", address: ADDR.morphoUSDC, decimals: 6 },
      placed: { maxAssets: usdc("1200000000", "1200"), escrow: usdc("950000000", "950") },
      remaining: { maxAssets: usdc("200000000", "200"), escrow: usdc("0", "0") },
      filled: usdc("1000000000", "1000"),
      status: "closed after fill",
      placedAt: iso(1_791_000_000),
      closedAt: iso(1_791_100_000),
    });
    expect(items[1]).toMatchObject({
      status: "live",
      closedAt: null,
      payToken: { symbol: "WETH" },
      placed: { escrow: { raw: "400000000000000000", human: "0.4", symbol: "WETH" } },
    });
    expect(first.nextCursor).toBe("2");
    const second = await getHistory(ctx, { network: "monad-testnet", view: "bids", address: ADDR.bidder, cursor: "2" });
    expect(requests[1]?.variables).toEqual({ market: lc(TESTNET.market), bidder: lc(ADDR.bidder) });
    expect((second.items as BidItem[]).map((b) => [b.bidId, b.status])).toEqual([["5", "cancelled"]]);
    expect(second).not.toHaveProperty("nextCursor");
  });

  it("summarises the Selio Vault and lists its actions, with base-yield source shares in the source's units", async () => {
    const state = {
      asset: lc(ADDR.morphoUSDC),
      totalSupply: "2000000000000",
      totalAssets: "2000000000",
      idle: "300000000",
      assetsPerShare: "1000000",
      depositedAssets: "2000000000",
      redeemedAssets: "0",
      redeemedReceiptUnits: "0",
      boughtAssets: "1000000000",
      boughtCost: "950000000",
      boughtFills: 1,
      recoveredAssets: "500000000",
      recoveryRateBps: 5_000,
      costRecoveryBps: 5_263,
      deferredUnits: "0",
      claimedUnits: "0",
      sourceShares: "600000000",
      sourceDepositedAssets: "700000000",
      sourceWithdrawnAssets: "0",
      sourcePulledAssets: "100000000",
      sourceSharesInKind: "0",
      lastPullUtilizationBps: 9_500,
      liveBid: { bidId: "9", capacityAssets: "0" },
      updatedAt: NOW,
    };
    const action = (kind: string, blockNumber: number, overrides: Record<string, unknown>) => ({
      kind,
      account: { id: lc(TESTNET.selioVault) },
      receiver: null,
      assets: null,
      shares: null,
      receiptUnits: null,
      utilizationBps: null,
      timestamp: NOW - 60,
      blockNumber,
      logIndex: 0,
      txHash: TX,
      ...overrides,
    });
    const actions = [
      action("SOURCE_PULL", 3, { assets: "100000000", shares: "99000000", utilizationBps: 9_500 }),
      action("RECOVER", 2, { account: { id: lc(ADDR.user) }, assets: "500000000" }),
      action("DEPOSIT", 1, {
        account: { id: lc(ADDR.user) },
        receiver: lc(ADDR.user),
        assets: "2000000000",
        shares: "2000000000000",
      }),
    ];
    const { url, requests } = await indexer(() => answer({ state, points: [], actions }));
    const { net, ctx } = testnet(url);
    net.reads.vaultBaseYield.mockResolvedValue({
      source: ADDR.waMonUSDC,
      sourceShares: 600_000_000n,
      sourceAssets: 606_000_000n,
      sourceUtilizationBps: 9_500,
    });
    const res = await getHistory(ctx, { network: "monad-testnet", view: "vault" });
    expect(requests[0]?.variables).toEqual({ market: lc(TESTNET.market), vault: lc(TESTNET.selioVault), since: 0 });
    expect(res.vault).toEqual({
      boughtFaceValue: usdc("1000000000", "1000"),
      boughtCost: usdc("950000000", "950"),
      recovered: usdc("500000000", "500"),
      recoveryRate: { bps: 5_000, percent: "50.00%" },
      costRecovered: { bps: 5_263, percent: "52.63%" },
      totalAssets: usdc("2000000000", "2000"),
      idle: usdc("300000000", "300"),
      sharesOutstanding: { raw: "2000000000000", human: "2000", symbol: "slUSDC" },
    });
    const items = res.items as VaultItem[];
    expect(items[0]).toEqual({
      kind: "SOURCE_PULL",
      account: TESTNET.selioVault,
      receiver: null,
      assets: usdc("100000000", "100"),
      shares: null,
      sourceShares: { raw: "99000000", human: "99", symbol: "waMonUSDC" },
      receiptUnits: null,
      sourceUtilization: { bps: 9_500, percent: "95.00%" },
      time: iso(NOW - 60),
      block: 3,
      txHash: TX,
    });
    expect(items[2]).toMatchObject({
      kind: "DEPOSIT",
      account: ADDR.user,
      receiver: ADDR.user,
      shares: { raw: "2000000000000", human: "2000", symbol: "slUSDC" },
      sourceShares: null,
    });
    expect(res.notes).toEqual([DISPLAY_ONLY_NOTE]);
  });

  it("summarises a wallet's sales, bids and totals per token, and returns null for a wallet the index has not seen", async () => {
    const account = {
      receiptShares: "5000000000000000000000",
      vaultShares: "0",
      sessionsOpened: 2,
      soldAssets: "1000000000",
      boughtAssets: "0",
      debtRepaid: "0",
      bidsPlaced: 1,
      firstSeenAt: NOW - 3600,
      lastSeenAt: NOW,
      tokens: [
        { token: lc(ADDR.morphoUSDC), receivedNet: "998000000", feesPaid: "2000000", paidAsBuyer: "0", escrowLive: "500000000" },
      ],
      borrowPositions: [],
    };
    let row: Record<string, unknown> | null = account;
    const { url, requests } = await indexer(() => answer({ account: row }));
    const { ctx } = testnet(url);
    const res = await getHistory(ctx, { network: "monad-testnet", view: "wallet", address: ADDR.seller });
    expect(requests[0]?.variables).toEqual({ market: lc(TESTNET.market), account: lc(ADDR.seller) });
    expect(res.items).toEqual([]);
    expect(res.account).toEqual({
      sold: usdc("1000000000", "1000"),
      bought: usdc("0", "0"),
      debtRepaid: usdc("0", "0"),
      sessionsOpened: 2,
      bidsPlaced: 1,
      receiptShares: { raw: "5000000000000000000000", human: "5000", symbol: "hyperUSDCa" },
      vaultShares: { raw: "0", human: "0", symbol: "slUSDC" },
      byToken: [
        {
          token: { symbol: "USDC", address: ADDR.morphoUSDC, decimals: 6 },
          receivedNet: usdc("998000000", "998"),
          feesPaid: usdc("2000000", "2"),
          paidAsBuyer: usdc("0", "0"),
          escrowLive: usdc("500000000", "500"),
        },
      ],
    });
    expect(res).not.toHaveProperty("nextCursor");

    row = null;
    expect((await getHistory(ctx, { network: "monad-testnet", view: "wallet", address: ADDR.user })).account).toBeNull();
  });
});
