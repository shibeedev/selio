import { useMemo } from "react";
import type { Address } from "viem";
import { forwardFill, IndexerClient, type IndexedFill, type IndexedInterval, type IndexStatus } from "@selio/sdk";
import type { EnvLike } from "./env";
import { describeError } from "./errors";
import type { SellerFill, SellerHistory } from "./history";
import { useAsync } from "./hooks";
import { useNetwork } from "./network-context";

/** Blocks behind the chain head that still count as up to date (about 15 s at 0.3 s blocks); the MCP uses the same. */
export const HISTORY_LAG_OK_BLOCKS = 50;
/** Every history read polls at this pace, and again after each confirmed transaction (refreshKey). */
export const HISTORY_POLL_MS = 15_000;

/** The GraphQL endpoint of the Selio event index, trimmed; null when the build has none. */
export function resolveIndexerUrl(env: EnvLike): string | null {
  const value = env.VITE_INDEXER_URL;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function indexerUrl(): string | null {
  return resolveIndexerUrl(import.meta.env);
}

export type HistoryState = "off" | "fork" | "unavailable" | "not-indexed" | "syncing" | "lagging" | "ready";

/** The state of the history views; null while the first status read is under way. */
export function historyState(p: {
  configured: boolean;
  indexed: boolean;
  status: IndexStatus | null;
  head: bigint | null;
  error: string | null;
}): HistoryState | null {
  if (!p.configured) return "off";
  if (!p.indexed) return "fork";
  if (p.error !== null) return "unavailable";
  if (!p.status) return null;
  if (!p.status.marketIndexed) return "not-indexed";
  if (!p.status.isReady) return "syncing";
  if (p.head !== null && p.head - BigInt(p.status.progressBlock) > BigInt(HISTORY_LAG_OK_BLOCKS)) return "lagging";
  return "ready";
}

/** A client of the index when this build has its URL and the selected network is indexed (Monad Testnet). */
export function useIndexer(): IndexerClient | null {
  const { info } = useNetwork();
  const url = indexerUrl();
  return useMemo(() => (url && info.indexed ? new IndexerClient({ url, chainId: info.chain.id }) : null), [url, info]);
}

export interface IndexerStatusView {
  state: HistoryState | null;
  status: IndexStatus | null;
  head: bigint | null;
  error: string | null;
}

/** How far the index has reached for the deployment's market, against the head read from the chain. */
export function useIndexerStatus(): IndexerStatusView {
  const { info, deployment, publicClient, refreshKey } = useNetwork();
  const client = useIndexer();
  const market = deployment.status === "ready" ? deployment.deployment.market : null;
  const read = useAsync(
    async () => {
      const [status, head] = await Promise.all([
        (client as IndexerClient).status(market as Address),
        // A failed head read only skips the lag test.
        publicClient.getBlockNumber().catch(() => null),
      ]);
      return { status, head };
    },
    [client, market, publicClient],
    { enabled: client !== null && market !== null, pollMs: HISTORY_POLL_MS, reloadKey: refreshKey },
  );
  const error = read.error != null ? describeError(read.error) : null;
  const status = read.data?.status ?? null;
  const head = read.data?.head ?? null;
  return {
    state: historyState({ configured: indexerUrl() !== null, indexed: info.indexed, status, head, error }),
    status,
    head,
    error,
  };
}

export function toSellerFill(f: IndexedFill): SellerFill {
  return {
    sessionId: f.sessionId,
    assets: f.assets,
    paid: f.paid,
    fee: f.fee,
    payToken: f.payToken,
    discountBps: f.discountBps,
    txHash: f.txHash,
    via: f.kind === "BORROWER_WALLET" || f.kind === "BORROWER_COLLATERAL" ? "borrower" : "bid",
  };
}

/** "Your sales" from the index, in the shape history.ts returns, so the table renders unchanged. */
export async function indexerSellerHistory(client: IndexerClient, market: Address, seller: Address): Promise<SellerHistory> {
  const { sessions, fills } = await client.sellerHistory(market, seller);
  return {
    opened: new Map(sessions.map((s) => [s.sessionId, s.openedAssets])),
    fills: fills.map(toSellerFill),
  };
}

/** "Your bids": each bid's whole size, filled plus remaining, from the index, so it stays exact after resizes. */
export async function indexerBidOrigins(client: IndexerClient, market: Address, bidder: Address): Promise<Map<bigint, bigint>> {
  const { bids } = await client.bidderHistory(market, bidder);
  return new Map(bids.map((b) => [b.bidId, b.filledAssets + b.maxAssets]));
}

export type HistoryRange = "24h" | "7d" | "30d" | "all";

export const HISTORY_RANGES: Record<HistoryRange, { label: string; seconds: number | null; interval: IndexedInterval }> = {
  "24h": { label: "24 hours", seconds: 86_400, interval: "HOUR" },
  "7d": { label: "7 days", seconds: 7 * 86_400, interval: "HOUR" },
  "30d": { label: "30 days", seconds: 30 * 86_400, interval: "DAY" },
  all: { label: "All", seconds: null, interval: "DAY" },
};

/** The first second a range covers (Unix seconds); "All" starts at 0. */
export function rangeSince(range: HistoryRange, nowSeconds: number): number {
  const seconds = HISTORY_RANGES[range].seconds;
  return seconds === null ? 0 : nowSeconds - seconds;
}

const BUCKET_SECONDS: Record<IndexedInterval, number> = { HOUR: 3_600, DAY: 86_400 };

/** The index's bucket start of a time: whole UTC hours or days. */
export function bucketStart(seconds: number, interval: IndexedInterval): number {
  const size = BUCKET_SECONDS[interval];
  return Math.floor(seconds / size) * size;
}

/** Every bucket start from the bucket of `from` to the bucket of `to`, oldest first. */
export function bucketStarts(from: number, to: number, interval: IndexedInterval): number[] {
  const size = BUCKET_SECONDS[interval];
  const out: number[] = [];
  for (let s = bucketStart(from, interval); s <= bucketStart(to, interval); s += size) out.push(s);
  return out;
}

/**
 * One value per bucket from `since` (or the first point, when the range starts before it) to now: points exist only
 * for buckets with events, so each bucket takes the latest point at or before it; buckets before any point are left out.
 */
export function filledBuckets<T extends { start: number }>(
  seed: T | null,
  points: readonly T[],
  since: number,
  nowSeconds: number,
  interval: IndexedInterval,
): { start: number; point: T }[] {
  const first = seed !== null ? since : (points[0]?.start ?? null);
  if (first === null) return [];
  const starts = bucketStarts(Math.max(first, since), nowSeconds, interval);
  const filled = forwardFill(seed, [...points], starts);
  return starts.flatMap((start, i) => {
    const point = filled[i];
    return point ? [{ start, point }] : [];
  });
}
