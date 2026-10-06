import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";
import {
  CAPACITY_POINTS_LIMIT,
  IndexerClient,
  IndexerError,
  NETWORKS,
  forwardFill,
  type IndexedCapacityPoint,
} from "./index.js";

const ENDPOINT = "https://indexer.example/v1/graphql";
// Lowercase as the index stores them; callers pass checksummed addresses.
const MARKET = "0x00000000000000000000000000000000000a11ce";
const SELLER = "0x00000000000000000000000000000000000005e1";
const BUYER = "0x0000000000000000000000000000000000000b0b";
const VAULT = "0x0000000000000000000000000000000000000fa7";
const USDC = "0x00000000000000000000000000000000000000dc";
const TX = `0x${"ab".repeat(32)}`;
const checksum = (a: string): Address => getAddress(a);

const META = { chainId: 10143, progressBlock: 1_000, sourceBlock: 1_005, isReady: true, readyAt: "2026-10-13T08:00:00+00:00" };

interface Sent {
  url: string;
  init: RequestInit;
  query: string;
  variables: Record<string, unknown>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The index's answer: the common head plus `data`. */
const answer = (data: Record<string, unknown>, head: Record<string, unknown> = {}) =>
  json({ data: { _meta: [META], market: { id: MARKET, updatedAt: 1 }, ...head, ...data } });

/** A client whose fetch records each request and answers with `respond`. */
function client(respond: (sent: Sent) => Response | Promise<Response>, opts: { timeoutMs?: number } = {}) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const request = { url: String(url), init, ...body };
    sent.push(request);
    return respond(request);
  });
  return { indexer: new IndexerClient({ url: ENDPOINT, fetch: fetch as unknown as typeof globalThis.fetch, ...opts }), sent };
}

function fill(overrides: Record<string, unknown> = {}) {
  return {
    kind: "SELL_NOW",
    sessionId: "0",
    bidId: "4",
    seller: { id: SELLER },
    buyer: { id: BUYER },
    buyerIsSelioVault: false,
    assets: "1000000000",
    paid: "950000000",
    fee: "1900000",
    sellerNet: "948100000",
    payToken: USDC,
    discountBps: 500,
    debtRepaid: null,
    timestamp: 1_791_872_663,
    blockNumber: 900,
    logIndex: 3,
    txHash: TX,
    txFrom: SELLER,
    ...overrides,
  };
}

function point(start: number, withdrawable: number | string): Record<string, unknown> {
  return {
    interval: "HOUR",
    start,
    updatedAt: start + 60,
    blockNumber: 10,
    withdrawable,
    supplied: "3",
    utilizationBps: 6666,
    debtorCapacity: "0",
    sessionAssets: "0",
    bidAt100: "0",
    bidAt300: "0",
    bidAt500: "1000000000",
    bidAt1000: "1000000000",
    bidAt2000: "1000000000",
    bidCapacityExact: true,
  };
}

async function failure(promise: Promise<unknown>): Promise<IndexerError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IndexerError);
  return err as IndexerError;
}

describe("IndexerClient requests", () => {
  it("POSTs one JSON document with the chain's _meta and the market row, and lowercases address variables", async () => {
    const { indexer, sent } = client(() => answer({ sessions: [], fills: [] }));
    await indexer.sellerHistory(checksum(MARKET), checksum(SELLER));
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(ENDPOINT);
    expect(request?.init.method).toBe("POST");
    expect(request?.init.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
    expect(request?.query).toMatch(/^query SellerHistory\(\$market: String!, \$seller: String!\) \{/);
    expect(request?.query).toContain("_meta(where: {chainId: {_eq: 10143}}) { chainId progressBlock sourceBlock isReady readyAt }");
    expect(request?.query).toContain("market: Market_by_pk(id: $market) { id updatedAt }");
    expect(request?.query).toContain("seller_id: {_eq: $seller}");
    expect(request?.variables).toEqual({ market: MARKET, seller: SELLER });
  });

  it("adds the seller, bidder and account filters only when asked, with paging variables", async () => {
    const { indexer, sent } = client(() => answer({ sessions: [], fills: [], fees: [], bids: [] }));
    await indexer.auctions(checksum(MARKET), { limit: 50 });
    await indexer.auctions(checksum(MARKET), { since: 1_700_000_000, seller: checksum(SELLER), limit: 50, offset: 50 });
    await indexer.fills(checksum(MARKET), { account: checksum(BUYER), limit: 20, offset: 40 });
    await indexer.bidderHistory(checksum(MARKET));
    await indexer.bidderHistory(checksum(MARKET), checksum(BUYER));
    const [all, bySeller, byAccount, allBids, byBidder] = sent;
    expect(all?.query).not.toContain("$seller");
    expect(all?.variables).toEqual({ market: MARKET, since: 0, limit: 50, offset: 0 });
    expect(bySeller?.query).toContain("seller_id: {_eq: $seller}");
    expect(bySeller?.variables).toEqual({ market: MARKET, since: 1_700_000_000, limit: 50, offset: 50, seller: SELLER });
    expect(byAccount?.query).toContain("_or: [{seller_id: {_eq: $account}}, {buyer_id: {_eq: $account}}]");
    expect(byAccount?.variables).toEqual({ market: MARKET, since: 0, limit: 20, offset: 40, account: BUYER });
    expect(allBids?.query).not.toContain("bidder_id");
    expect(allBids?.variables).toEqual({ market: MARKET });
    expect(byBidder?.query).toContain("bidder_id: {_eq: $bidder}");
    expect(byBidder?.variables).toEqual({ market: MARKET, bidder: BUYER });
  });

  it("writes the bucket interval into the document and defaults the point limit", async () => {
    const { indexer, sent } = client(() => answer({ points: [], seed: [] }));
    await indexer.capacity(checksum(MARKET), { interval: "DAY", since: 1_791_849_600 });
    expect(sent[0]?.query).toContain('interval: {_eq: "DAY"}, start: {_gte: $since}');
    expect(sent[0]?.query).toContain('interval: {_eq: "DAY"}, start: {_lt: $since}');
    expect(sent[0]?.variables).toEqual({ market: MARKET, since: 1_791_849_600, limit: CAPACITY_POINTS_LIMIT });
    await expect(
      indexer.capacity(checksum(MARKET), { interval: 'HOUR"}}) { id } x: Fill(where: {' as "HOUR", since: 0 }),
    ).rejects.toThrow(/expected one of HOUR, DAY/);
    expect(sent).toHaveLength(1);
  });
});

describe("IndexerClient parsing", () => {
  it("reads the index status and whether the market is indexed", async () => {
    const { indexer } = client(() => answer({}));
    expect(await indexer.status(checksum(MARKET))).toEqual({
      chainId: 10143,
      progressBlock: 1_000,
      sourceBlock: 1_005,
      isReady: true,
      readyAt: "2026-10-13T08:00:00+00:00",
      marketIndexed: true,
    });
    const unknown = client(() => answer({}, { market: null, _meta: [{ ...META, isReady: false, readyAt: null }] }));
    expect(await unknown.indexer.status(checksum(MARKET))).toMatchObject({
      isReady: false,
      readyAt: null,
      marketIndexed: false,
    });
  });

  it("parses BigInt columns sent as strings or numbers and checksums addresses", async () => {
    const { indexer } = client(() =>
      answer({
        sessions: [{ sessionId: "7", openedAssets: 2_000_000_000 }],
        fills: [
          fill(),
          fill({
            kind: "BORROWER_WALLET",
            sessionId: 7,
            bidId: null,
            assets: 1e21,
            paid: 1_000_000_000,
            fee: 2_000_000,
            sellerNet: 998_000_000,
            debtRepaid: "1000000000",
          }),
        ],
      }),
    );
    const { sessions, fills, status } = await indexer.sellerHistory(checksum(MARKET), checksum(SELLER));
    expect(status.marketIndexed).toBe(true);
    expect(sessions).toEqual([{ sessionId: 7n, openedAssets: 2_000_000_000n }]);
    expect(fills[0]).toEqual({
      kind: "SELL_NOW",
      sessionId: 0n,
      bidId: 4n,
      seller: checksum(SELLER),
      buyer: checksum(BUYER),
      buyerIsSelioVault: false,
      assets: 1_000_000_000n,
      paid: 950_000_000n,
      fee: 1_900_000n,
      sellerNet: 948_100_000n,
      payToken: checksum(USDC),
      discountBps: 500,
      debtRepaid: null,
      timestamp: 1_791_872_663,
      blockNumber: 900,
      logIndex: 3,
      txHash: TX,
      txFrom: checksum(SELLER),
    });
    expect(fills[1]).toMatchObject({
      kind: "BORROWER_WALLET",
      sessionId: 7n,
      bidId: null,
      assets: 10n ** 21n,
      paid: 1_000_000_000n,
      fee: 2_000_000n,
      sellerNet: 998_000_000n,
      debtRepaid: 1_000_000_000n,
    });
  });

  it("returns capacity points oldest first with the seed before the window, or no seed", async () => {
    const { indexer } = client(() => answer({ points: [point(7200, "2"), point(10_800, 1)], seed: [point(0, "0")] }));
    const { seed, points } = await indexer.capacity(checksum(MARKET), { interval: "HOUR", since: 3600, limit: 10 });
    expect(seed).toMatchObject({ interval: "HOUR", start: 0, withdrawable: 0n, utilizationBps: 6666 });
    expect(points.map((p) => [p.start, p.withdrawable])).toEqual([
      [7200, 2n],
      [10_800, 1n],
    ]);
    expect(points[0]).toMatchObject({ bidAt100: 0n, bidAt500: 1_000_000_000n, bidCapacityExact: true, supplied: 3n });
    const empty = client(() => answer({ points: [], seed: [] }));
    expect((await empty.indexer.capacity(checksum(MARKET), { interval: "HOUR", since: 0 })).seed).toBeNull();
  });

  it("parses auctions with their fills, bids, vault state, points and actions, and wallets", async () => {
    const session = {
      sessionId: "3",
      seller: { id: SELLER },
      startedAt: 1_000,
      endsAt: 87_400,
      startBps: 50,
      stepBps: 25,
      stepInterval: 900,
      capBps: 500,
      openedAssets: "5000000",
      soldAssets: "1000000",
      withdrawnAssets: "0",
      listedAssets: "4000000",
      fillCount: 1,
      avgDiscountBps: null,
      fills: [{ timestamp: 2_000, discountBps: 75, assets: "1000000", kind: "AUCTION_MATCH" }],
    };
    const bid = {
      bidId: "9",
      bidder: { id: VAULT },
      isSelioVault: true,
      maxAssetsPlaced: "1200000000",
      escrowPlaced: "950000000",
      maxAssets: "200000000",
      escrow: "0",
      filledAssets: "1000000000",
      paidOut: "950000000",
      status: "CLOSED_AFTER_FILL",
      placedAt: 1_500,
      closedAt: 1_600,
      payToken: USDC,
      minDiscountBps: 500,
    };
    const state = {
      asset: USDC,
      totalSupply: "1000000000000",
      totalAssets: "1000000000",
      idle: "200000000",
      assetsPerShare: "1000000",
      depositedAssets: "1000000000",
      redeemedAssets: "0",
      redeemedReceiptUnits: "0",
      boughtAssets: "1000000000",
      boughtCost: "950000000",
      boughtFills: 1,
      recoveredAssets: "500000000",
      recoveryRateBps: 5000,
      costRecoveryBps: 5263,
      deferredUnits: "0",
      claimedUnits: "0",
      sourceShares: "700000000000000000000",
      sourceDepositedAssets: "700000000",
      sourceWithdrawnAssets: "0",
      sourcePulledAssets: "0",
      sourceSharesInKind: "0",
      lastPullUtilizationBps: null,
      liveBid: { bidId: "9", capacityAssets: "0" },
      updatedAt: 1_600,
    };
    const vaultPoint = {
      interval: "DAY",
      start: 0,
      totalAssets: "1000000000",
      idle: "200000000",
      totalSupply: "1000000000000",
      assetsPerShare: "1000000",
      depositedAssets: "1000000000",
      redeemedAssets: "0",
      recoveredAssets: "500000000",
      boughtAssets: "1000000000",
      boughtCost: "950000000",
      sourceShares: "700000000000000000000",
    };
    const action = {
      kind: "SOURCE_PULL",
      account: { id: VAULT },
      receiver: null,
      assets: "100000000",
      shares: "100000000000000000000",
      receiptUnits: null,
      utilizationBps: 9_500,
      timestamp: 1_700,
      blockNumber: 950,
      logIndex: 0,
      txHash: TX,
    };
    const account = {
      receiptShares: "5000000000000000000000",
      vaultShares: "0",
      sessionsOpened: 1,
      soldAssets: "1000000",
      boughtAssets: "0",
      debtRepaid: "0",
      bidsPlaced: 0,
      firstSeenAt: 1_000,
      lastSeenAt: 2_000,
      tokens: [{ token: USDC, receivedNet: "998000", feesPaid: "2000", paidAsBuyer: "0", escrowLive: "0" }],
      borrowPositions: [{ marketId: `0x${"11".repeat(32)}`, borrowShares: "5", collateral: "6" }],
    };
    const { indexer } = client(() =>
      answer({ sessions: [session], bids: [bid], state, points: [vaultPoint], actions: [action], account }),
    );
    const [auctions, bids, vault, wallet] = await Promise.all([
      indexer.auctions(checksum(MARKET), { limit: 50 }),
      indexer.bidderHistory(checksum(MARKET), checksum(VAULT)),
      indexer.vault(checksum(MARKET), checksum(VAULT), { interval: "DAY", since: 0 }),
      indexer.wallet(checksum(MARKET), checksum(SELLER)),
    ]);
    expect(auctions.sessions[0]).toMatchObject({
      sessionId: 3n,
      seller: checksum(SELLER),
      listedAssets: 4_000_000n,
      avgDiscountBps: null,
      fills: [{ timestamp: 2_000, discountBps: 75, assets: 1_000_000n, kind: "AUCTION_MATCH" }],
    });
    expect(bids.bids[0]).toMatchObject({ bidId: 9n, bidder: checksum(VAULT), status: "CLOSED_AFTER_FILL", closedAt: 1_600 });
    expect(vault.state).toMatchObject({
      asset: checksum(USDC),
      recoveryRateBps: 5000,
      sourceShares: 700n * 10n ** 18n,
      lastPullUtilizationBps: null,
      liveBid: { bidId: 9n, capacityAssets: 0n },
    });
    expect(vault.points[0]).toMatchObject({ interval: "DAY", sourceShares: 700n * 10n ** 18n });
    expect(vault.actions[0]).toEqual({
      kind: "SOURCE_PULL",
      account: checksum(VAULT),
      receiver: null,
      assets: 100_000_000n,
      shares: 100n * 10n ** 18n,
      receiptUnits: null,
      utilizationBps: 9_500,
      timestamp: 1_700,
      blockNumber: 950,
      logIndex: 0,
      txHash: TX,
    });
    expect(wallet.account).toMatchObject({
      receiptShares: 5_000n * 10n ** 18n,
      tokens: [{ token: checksum(USDC), receivedNet: 998_000n, feesPaid: 2_000n }],
      borrowPositions: [{ marketId: `0x${"11".repeat(32)}`, borrowShares: 5n, collateral: 6n }],
    });
  });

  it("returns null for a vault or wallet the index has no row for", async () => {
    const { indexer } = client(() => answer({ state: null, points: [], actions: [], account: null }));
    expect((await indexer.vault(checksum(MARKET), checksum(VAULT), { interval: "HOUR", since: 0 })).state).toBeNull();
    expect((await indexer.wallet(checksum(MARKET), checksum(SELLER))).account).toBeNull();
  });
});

describe("IndexerError", () => {
  it("reports a network failure as offline, with the reason", async () => {
    const { indexer } = client(() => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") });
    });
    const err = await failure(indexer.status(checksum(MARKET)));
    expect(err).toMatchObject({ offline: true, status: null, name: "IndexerError" });
    expect(err.message).toBe("The Selio indexer could not be reached: connect ECONNREFUSED 127.0.0.1:8080.");
  });

  it("aborts a request that outlives the timeout and reports it as offline", async () => {
    const { indexer } = client(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
        }),
      { timeoutMs: 20 },
    );
    const err = await failure(indexer.status(checksum(MARKET)));
    expect(err).toMatchObject({ offline: true, status: null });
    expect(err.message).toBe("The Selio indexer did not answer within 20 ms.");
  });

  it("reports a non-OK HTTP status with that status, and 429 as rate limiting", async () => {
    const limited = await failure(client(() => json({}, 429)).indexer.status(checksum(MARKET)));
    expect(limited).toMatchObject({ offline: false, status: 429 });
    expect(limited.message).toBe("The Selio indexer is rate-limiting requests; try again shortly.");
    const missing = await failure(client(() => new Response("Not Found", { status: 404 })).indexer.status(checksum(MARKET)));
    expect(missing).toMatchObject({ offline: false, status: 404, message: "The Selio indexer answered HTTP 404" });
  });

  it("reports a body that is not JSON as offline", async () => {
    const err = await failure(client(() => new Response("<html>bad gateway</html>")).indexer.status(checksum(MARKET)));
    expect(err).toMatchObject({ offline: true, status: null });
    expect(err.message).toBe("The Selio indexer answered with a body that is not JSON.");
  });

  it("passes GraphQL errors through and names a chain the index does not cover", async () => {
    const graphqlError = client(() => json({ errors: [{ message: "field 'Fill' not found in type: 'query_root'" }] }));
    expect(await failure(graphqlError.indexer.status(checksum(MARKET)))).toMatchObject({
      offline: false,
      status: 200,
      message: "field 'Fill' not found in type: 'query_root'",
    });
    const noChain = client(() => answer({}, { _meta: [] }));
    expect(await failure(noChain.indexer.status(checksum(MARKET)))).toMatchObject({
      offline: false,
      status: 200,
      message: "The Selio indexer does not index chain 10143.",
    });
  });

  it("reports rows that do not match the expected fields", async () => {
    const { indexer } = client(() => answer({ sessions: [], fills: [fill({ assets: null })] }));
    const err = await failure(indexer.sellerHistory(checksum(MARKET), checksum(SELLER)));
    expect(err).toMatchObject({ offline: false, status: 200 });
    expect(err.message).toBe("The Selio indexer answered with unexpected data: expected an integer amount, got null");
  });
});

describe("forwardFill", () => {
  const at = (start: number, withdrawable: bigint) => ({ start, withdrawable }) as Pick<IndexedCapacityPoint, "start" | "withdrawable">;

  it("holds each point until the next one, starts from the seed, and is null before any point", () => {
    const seed = at(0, 5n);
    const points = [at(7200, 2n), at(14_400, 1n)];
    const filled = forwardFill(seed, points, [3600, 7200, 10_800, 14_400, 18_000]);
    expect(filled.map((p) => p?.withdrawable)).toEqual([5n, 2n, 2n, 1n, 1n]);
    expect(forwardFill(null, points, [3600, 7200]).map((p) => p?.withdrawable ?? null)).toEqual([null, 2n]);
    expect(forwardFill(null, [], [0])).toEqual([null]);
  });
});

describe("NETWORKS", () => {
  it("marks monad-testnet as indexed and the scenario forks as not", () => {
    expect(NETWORKS["monad-testnet"].indexed).toBe(true);
    expect(NETWORKS["usdt0-replay"].indexed).toBe(false);
    expect(NETWORKS["vault-freeze"].indexed).toBe(false);
  });
});
