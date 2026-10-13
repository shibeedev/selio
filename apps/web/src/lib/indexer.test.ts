import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { IndexedCapacityPoint, IndexedFill, IndexerClient, IndexStatus } from "@selio/sdk";
import { amountChartGeometry, discountCurveGeometry } from "./chart";
import {
  bucketStart,
  bucketStarts,
  filledBuckets,
  HISTORY_LAG_OK_BLOCKS,
  historyState,
  indexerBidOrigins,
  indexerSellerHistory,
  rangeSince,
  resolveIndexerUrl,
} from "./indexer";

const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
const SELLER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

const status = (patch: Partial<IndexStatus> = {}): IndexStatus => ({
  chainId: 10143,
  progressBlock: 1_000,
  sourceBlock: 1_010,
  isReady: true,
  readyAt: "2026-10-13T10:00:00Z",
  marketIndexed: true,
  ...patch,
});
const state = (patch: Partial<Parameters<typeof historyState>[0]> = {}) =>
  historyState({ configured: true, indexed: true, status: status(), head: 1_020n, error: null, ...patch });

describe("history state", () => {
  it("is off without an indexer URL, even on a fork", () => {
    expect(state({ configured: false })).toBe("off");
    expect(state({ configured: false, indexed: false })).toBe("off");
  });

  it("shows only the fork note on a network the index does not cover", () => {
    expect(state({ indexed: false })).toBe("fork");
  });

  it("is unavailable when the index or its status cannot be read", () => {
    expect(state({ error: "The Selio indexer could not be reached: refused." })).toBe("unavailable");
  });

  it("says when the index does not know the deployment's market", () => {
    expect(state({ status: status({ marketIndexed: false }) })).toBe("not-indexed");
  });

  it("is syncing until the historical sync finishes", () => {
    expect(state({ status: status({ isReady: false }) })).toBe("syncing");
  });

  it("is lagging beyond HISTORY_LAG_OK_BLOCKS behind the chain head, ready within it", () => {
    expect(state({ head: BigInt(1_000 + HISTORY_LAG_OK_BLOCKS) })).toBe("ready");
    expect(state({ head: BigInt(1_000 + HISTORY_LAG_OK_BLOCKS + 1) })).toBe("lagging");
  });

  it("skips the lag test when the head read failed, and waits for the first status", () => {
    expect(state({ head: null, status: status({ progressBlock: 1 }) })).toBe("ready");
    expect(state({ status: null })).toBeNull();
  });

  it("reads the URL from VITE_INDEXER_URL, trimmed, trailing slashes as given", () => {
    expect(resolveIndexerUrl({ VITE_INDEXER_URL: "  https://indexer.dev.hyperindex.xyz/abc/v1/graphql/ " })).toBe(
      "https://indexer.dev.hyperindex.xyz/abc/v1/graphql/",
    );
    expect(resolveIndexerUrl({ VITE_INDEXER_URL: "  " })).toBeNull();
    expect(resolveIndexerUrl({})).toBeNull();
  });
});

const fill = (patch: Partial<IndexedFill>): IndexedFill => ({
  kind: "SELL_NOW",
  sessionId: 0n,
  bidId: 2n,
  seller: SELLER,
  buyer: USDC,
  buyerIsSelioVault: false,
  assets: 1_000_000_000n,
  paid: 980_000_000n,
  fee: 1_960_000n,
  sellerNet: 978_040_000n,
  payToken: USDC,
  discountBps: 200,
  debtRepaid: null,
  timestamp: 1_791_872_663,
  blockNumber: 70_000_001,
  logIndex: 3,
  txHash: TX,
  txFrom: SELLER,
  ...patch,
});

describe("indexed sources of Your sales and Your bids", () => {
  it("maps the index's seller history to the shape of history.ts", async () => {
    const client = {
      sellerHistory: async (market: Address, seller: Address) => {
        expect([market, seller]).toEqual([MARKET, SELLER]);
        return {
          status: status(),
          sessions: [{ sessionId: 3n, openedAssets: 2_500_000_000n }],
          fills: [
            fill({ kind: "BORROWER_WALLET", sessionId: 3n, bidId: null, debtRepaid: 1_000_000_000n }),
            fill({ kind: "BORROWER_COLLATERAL", sessionId: 3n, bidId: null }),
            fill({ kind: "AUCTION_MATCH", sessionId: 3n }),
            fill({}),
          ],
        };
      },
    } as unknown as IndexerClient;
    const history = await indexerSellerHistory(client, MARKET, SELLER);
    expect(history.opened).toEqual(new Map([[3n, 2_500_000_000n]]));
    expect(history.fills.map((f) => f.via)).toEqual(["borrower", "borrower", "bid", "bid"]);
    expect(history.fills[3]).toEqual({
      sessionId: 0n,
      assets: 1_000_000_000n,
      paid: 980_000_000n,
      fee: 1_960_000n,
      payToken: USDC,
      discountBps: 200,
      txHash: TX,
      via: "bid",
    });
  });

  it("gives each of the bidder's bids its whole size: filled plus remaining", async () => {
    const client = {
      bidderHistory: async () => ({
        status: status(),
        bids: [
          { bidId: 5n, filledAssets: 300_000_000n, maxAssets: 900_000_000n },
          { bidId: 6n, filledAssets: 0n, maxAssets: 50_000_000n },
        ],
      }),
    } as unknown as IndexerClient;
    expect(await indexerBidOrigins(client, MARKET, SELLER)).toEqual(
      new Map([
        [5n, 1_200_000_000n],
        [6n, 50_000_000n],
      ]),
    );
  });
});

const point = (start: number, utilizationBps: number, withdrawable = 0n): IndexedCapacityPoint => ({
  interval: "HOUR",
  start,
  updatedAt: start + 60,
  blockNumber: 1,
  withdrawable,
  supplied: 1_000n,
  utilizationBps,
  debtorCapacity: 0n,
  sessionAssets: 0n,
  bidAt100: 0n,
  bidAt300: 0n,
  bidAt500: 0n,
  bidAt1000: 0n,
  bidAt2000: 0n,
  bidCapacityExact: true,
});

describe("buckets and forward fill", () => {
  it("uses the index's UTC hour and day buckets", () => {
    expect(bucketStart(1_791_872_663, "HOUR")).toBe(1_791_871_200);
    expect(bucketStart(1_791_872_663, "DAY")).toBe(1_791_849_600);
    expect(bucketStarts(7_200, 14_399, "HOUR")).toEqual([7_200, 10_800]);
    expect(rangeSince("24h", 100_000)).toBe(13_600);
    expect(rangeSince("all", 100_000)).toBe(0);
  });

  it("fills empty buckets with the latest earlier point, starting from the seed, up to the current bucket", () => {
    const seed = point(0, 9_000);
    const points = [point(7_200, 9_500), point(14_400, 9_900)];
    const filled = filledBuckets(seed, points, 3_600, 18_000, "HOUR");
    expect(filled.map((b) => [b.start, b.point.utilizationBps])).toEqual([
      [3_600, 9_000],
      [7_200, 9_500],
      [10_800, 9_500],
      [14_400, 9_900],
      [18_000, 9_900],
    ]);
  });

  it("starts at the first point when nothing happened before the range", () => {
    const filled = filledBuckets(null, [point(10_800, 9_100)], 0, 14_400, "HOUR");
    expect(filled.map((b) => b.start)).toEqual([10_800, 14_400]);
    expect(filledBuckets(null, [], 0, 14_400, "HOUR")).toEqual([]);
  });
});

const BOX = { width: 440, height: 120, left: 40, right: 0, top: 10, bottom: 10 };

describe("history charts", () => {
  it("scales amounts from 0 to the largest value and steps after each point", () => {
    const g = amountChartGeometry(
      [
        { t: 0, a: 0n, b: 4_000_000n },
        { t: 1, a: 2_000_000n, b: 4_000_000n },
      ],
      [
        { key: "a", value: (p) => p.a },
        { key: "b", value: (p) => p.b },
      ],
      BOX,
      6,
    );
    expect(g.max).toBe(4_000_000n);
    expect(g.ticks.map((t) => t.label)).toEqual(["0", "1", "2", "3", "4"]);
    // From a thousand units up, ticks drop their decimals.
    const big = amountChartGeometry([{ t: 0, v: 289_977_180_000n }], [{ key: "v", value: (p) => p.v }], BOX, 6);
    expect(big.ticks.map((t) => t.label)).toEqual(["0", "72,494", "144,989", "217,483", "289,977"]);
    expect(g.ticks.map((t) => t.y)).toEqual([110, 85, 60, 35, 10]);
    expect(g.lines[0]?.points).toBe("40,110 440,110 440,60");
    expect(g.lines[1]?.points).toBe("40,10 440,10 440,10");
  });

  it("can start the scale at the smallest value, for the vault's share value", () => {
    const g = amountChartGeometry(
      [
        { t: 0, v: 1_000_000n },
        { t: 1, v: 1_002_000n },
      ],
      [{ key: "v", value: (p) => p.v }],
      BOX,
      6,
      { fromData: true, maxDecimals: 6 },
    );
    expect(g.ticks.map((t) => t.label)).toEqual(["1", "1.0005", "1.001", "1.0015", "1.002"]);
    expect(g.lines[0]?.points).toBe("40,110 440,110 440,10");
    const flat = amountChartGeometry([{ t: 0, v: 1_000_000n }], [{ key: "v", value: (p) => p.v }], BOX, 6, { fromData: true });
    expect(flat.lines[0]?.points).toBe("440,10");
  });

  it("uses one whole token as the scale when every value is zero", () => {
    const g = amountChartGeometry([{ t: 0, v: 0n }], [{ key: "v", value: (p) => p.v }], BOX, 6);
    expect(g.max).toBe(1_000_000n);
    expect(g.ticks[4]?.label).toBe("1");
  });

  it("draws an auction's discount schedule up to its cap, with a dot per fill", () => {
    const g = discountCurveGeometry(
      {
        startedAt: 0,
        endsAt: 10_000,
        startBps: 100,
        stepBps: 100,
        stepInterval: 1_000,
        capBps: 300,
        fills: [{ timestamp: 2_500, discountBps: 300 }],
      },
      4_000,
      BOX,
    );
    // Steps at 1,000 s and 2,000 s reach the 3% cap, which then holds to "now" at 4,000 s.
    expect(g.points).toBe("40,76.7 140,76.7 140,43.3 240,43.3 240,10 440,10");
    expect(g.dots).toEqual([{ x: 290, y: 10, bps: 300 }]);
    expect(g.ticks.map((t) => t.label)).toEqual(["0.00%", "1.50%", "3.00%"]);
  });
});
