import { isAddressEqual, type Address } from "viem";
import type { BidView, IndexerClient, SelioClient, SessionView } from "@selio/sdk";
import { Chip, Notice } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { describeError } from "../../lib/errors";
import { formatFillAmounts } from "../../lib/fees";
import { formatBps, formatToken } from "../../lib/format";
import { loadSellerHistory, summarizeFills, type FillSummary, type SellerFill } from "../../lib/history";
import { useAsync } from "../../lib/hooks";
import { HISTORY_POLL_MS, indexerSellerHistory, useIndexer, useIndexerStatus } from "../../lib/indexer";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { maskIncludes } from "../../lib/paymask";
import { useTxRunner } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

/** The escrowed bid an open auction can fill now: the largest capacity whose minimum the discount has reached. */
function matchableBid(session: SessionView, bids: readonly BidView[]): BidView | null {
  if (!session.open) return null;
  let best: BidView | null = null;
  for (const b of bids) {
    if (b.capacityAssets === 0n || b.minDiscountBps > session.discountBps || !maskIncludes(session.payMask, b.payIdx)) continue;
    if (!best || b.capacityAssets > best.capacityAssets) best = b;
  }
  return best;
}

function statusOf(s: SessionView, chainNow: number): "Open" | "Ended" | "Closed" {
  if (s.units === 0n) return "Closed";
  if (chainNow >= s.endsAt) return "Ended";
  return "Open";
}

function Received({ summary, meta, testid }: { summary: FillSummary; meta: MarketMeta; testid?: string }) {
  const charged = summary.fees.some((f) => f.amount > 0n);
  return (
    <>
      {formatFillAmounts(summary.received, meta.payTokens)}
      {charged && (
        <div className="cell-sub" data-testid={testid}>
          fee {formatFillAmounts(summary.fees, meta.payTokens)}
        </div>
      )}
    </>
  );
}

/** The seller's auctions and sell-now fills, with what each paid net of the fee. */
export function YourSales({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { info, refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const U = meta.underlying;

  const sales = useAsync(
    async () => {
      const [sessions, bids, block] = await Promise.all([selio.sessions(), selio.bids(), selio.client.getBlock()]);
      return { mine: sessions.filter((s) => isAddressEqual(s.seller, address as Address)), bids, chainNow: Number(block.timestamp) };
    },
    [selio, address],
    { enabled: !!address, pollMs: 15_000, reloadKey: refreshKey },
  );
  // The public Monad testnet RPC serves logs 100 blocks at a time, so an indexed network reads sold and
  // received amounts from the Selio event index; the forks keep reading their own logs.
  const indexer = useIndexer();
  const index = useIndexerStatus();
  const history = useAsync(
    () =>
      info.indexed
        ? indexerSellerHistory(indexer as IndexerClient, selio.market, address as Address)
        : loadSellerHistory(selio, address as Address),
    [selio, address, indexer],
    {
      enabled: !!address && (!info.indexed || indexer !== null),
      pollMs: info.indexed ? HISTORY_POLL_MS : undefined,
      reloadKey: refreshKey,
    },
  );

  if (!address) return null;

  const busy = runner.state.busy !== null;
  const blocked = !!wallet.writeBlockedReason;
  const fills = history.data?.fills ?? [];
  const sellNowGroups = new Map<string, SellerFill[]>();
  fills
    .filter((f) => f.sessionId === 0n)
    .forEach((f, n) => {
      const key = f.txHash ?? `fill-${n}`;
      sellNowGroups.set(key, [...(sellNowGroups.get(key) ?? []), f]);
    });
  const mine = sales.data?.mine ?? [];
  const empty = sales.data !== undefined && mine.length === 0 && sellNowGroups.size === 0;

  const withdraw = (s: SessionView) =>
    runner.send(async () => [
      {
        label: `Withdraw ${formatToken(s.remainingAssets, U)} unsold from auction #${s.id}`,
        tx: selio.withdrawUnsold(s.id),
      },
    ]);
  const match = (s: SessionView, bid: BidView) =>
    runner.send(async () => [
      {
        label: `Fill ${isAddressEqual(bid.bidder, meta.vault.address) ? "the Selio Vault's" : "a limit"} bid #${bid.id} from auction #${s.id} at ${formatBps(s.discountBps)}`,
        tx: selio.matchBid(s.id, bid.id),
      },
    ]);

  return (
    <section className="card card--pad stack" aria-labelledby="h-mine">
      <h2 id="h-mine" className="h2-sm">
        Your sales
      </h2>
      {sales.error != null && <Notice tone="danger">Can't read your auctions: {describeError(sales.error)}</Notice>}
      {history.error != null &&
        (info.indexed ? (
          <p className="small muted">
            Sold and received amounts come from the Selio indexer, which could not be read: {describeError(history.error)}
          </p>
        ) : (
          <p className="small muted">
            Sold and received amounts come from event history, which this RPC could not serve: {describeError(history.error)}
          </p>
        ))}
      {info.indexed && indexer === null && (
        <p className="small muted">Sold and received amounts come from the Selio indexer, which this build does not point to.</p>
      )}
      {sales.data === undefined && sales.error == null && <p className="muted loading">Reading your auctions…</p>}
      {empty && <p className="muted">No sales yet. Your auctions and sell-now fills show up here.</p>}
      {sales.data !== undefined && !empty && (
        <div className="table-wrap">
          <table className="data data--wide">
            <thead>
              <tr>
                <th scope="col">Sale</th>
                <th scope="col">Sold</th>
                <th scope="col">Discount</th>
                <th scope="col">Received</th>
                <th scope="col">Status</th>
                <th scope="col">Unsold</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((s) => {
                const own = fills.filter((f) => f.sessionId === s.id);
                const summary = summarizeFills(own);
                const opened = history.data?.opened.get(s.id) ?? summary.assets + s.remainingAssets;
                const status = statusOf(s, sales.data!.chainNow);
                const bid = matchableBid(s, sales.data!.bids);
                const discount = s.open
                  ? s.discountBps >= s.capBps
                    ? `${formatBps(s.discountBps)}, at its cap`
                    : `${formatBps(s.discountBps)} now, rising`
                  : summary.avgDiscountBps === null
                    ? "—"
                    : formatBps(summary.avgDiscountBps);
                return (
                  <tr key={String(s.id)} data-testid={`session-row-${s.id}`} data-status={status.toLowerCase()}>
                    <td>
                      <div className="cell-title">{receiptNoun(meta)}</div>
                      <div className="cell-sub">Auction #{String(s.id)}</div>
                    </td>
                    <td className="mono" data-testid={`session-sold-${s.id}`}>
                      {history.data ? `${formatToken(summary.assets, U)} of ${formatToken(opened, U)}` : "—"}
                    </td>
                    <td className="mono" data-testid={`session-discount-${s.id}`}>
                      {discount}
                    </td>
                    <td className="mono">
                      {history.data ? <Received summary={summary} meta={meta} testid={`session-fee-${s.id}`} /> : "—"}
                    </td>
                    <td>
                      <Chip tone={status === "Open" ? "open" : "neutral"}>{status}</Chip>
                    </td>
                    <td>
                      <div className="row-sm">
                        {s.units > 0n ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--small"
                            disabled={busy || blocked}
                            onClick={() => void withdraw(s)}
                            data-testid={`session-withdraw-${s.id}`}
                          >
                            Withdraw {formatToken(s.remainingAssets, U)}
                          </button>
                        ) : (
                          <span className="muted">None</span>
                        )}
                        {bid && (
                          <button
                            type="button"
                            className="btn btn--primary btn--small"
                            disabled={busy || blocked}
                            onClick={() => void match(s, bid)}
                            title="Your discount has reached this escrowed bid, so it can buy now. Anyone may trigger the fill; you get paid."
                            data-testid={`session-match-${s.id}`}
                          >
                            Sell to bid at {formatBps(s.discountBps)}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {[...sellNowGroups].map(([key, group]) => {
                const summary = summarizeFills(group);
                return (
                  <tr key={key} data-testid="sellnow-row">
                    <td>
                      <div className="cell-title">{receiptNoun(meta)}</div>
                      <div className="cell-sub">Sold now to bids</div>
                    </td>
                    <td className="mono">{formatToken(summary.assets, U)}</td>
                    <td className="mono">{summary.avgDiscountBps === null ? "—" : formatBps(summary.avgDiscountBps)}</td>
                    <td className="mono">
                      <Received summary={summary} meta={meta} />
                    </td>
                    <td>
                      <Chip tone="neutral">Filled</Chip>
                    </td>
                    <td>
                      <span className="muted">None</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {info.indexed && (index.state === "lagging" || index.state === "syncing") && index.status && (
        <p className="small muted">
          Sold and received amounts are indexed to block {index.status.progressBlock.toLocaleString("en-US")}; newer fills appear
          shortly.
        </p>
      )}
      <p className="small muted">Unsold receipts come back to you at once, with no waiting period; what already sold stays sold.</p>
      <TxStatus state={runner.state} />
    </section>
  );
}
