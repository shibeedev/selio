import { Fragment, useState } from "react";
import { isAddressEqual } from "viem";
import type { IndexedSession } from "@selio/sdk";
import { Chip, Notice } from "../../components/ui";
import { discountCurveGeometry } from "../../lib/chart";
import { describeError } from "../../lib/errors";
import { formatBps, formatDuration, formatToken, shortAddress } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { HISTORY_POLL_MS, rangeSince } from "../../lib/indexer";
import { useNetwork } from "../../lib/network-context";
import { useWallet } from "../../lib/wallet-context";
import { axisTime, useChartBox } from "./CapacityHistory";
import type { HistoryPanelProps } from "./HistoryPage";

const PAGE = 50;

function DiscountCurve({ session: s, now }: { session: IndexedSession; now: number }) {
  const [ref, box] = useChartBox();
  const g = discountCurveGeometry(s, now, box);
  const right = box.width - box.right;
  const bottom = box.height - box.bottom;
  return (
    <div ref={ref}>
      <svg
        className="chart"
        viewBox={`0 0 ${box.width} ${box.height}`}
        width="100%"
        height={box.height}
        role="img"
        aria-label={`Discount schedule of auction ${s.sessionId} with ${s.fills.length} fills`}
        data-testid={`history-auction-curve-${s.sessionId}`}
      >
        {g.ticks.map((tick) => (
          <g key={tick.label}>
            <line className="chart-grid" x1={box.left} x2={right} y1={tick.y} y2={tick.y} />
            <text className="chart-label" x={box.left - 8} y={tick.y + 4} textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}
        <line className="chart-axis" x1={box.left} x2={box.left} y1={box.top} y2={bottom} />
        <polyline className="chart-line" points={g.points} fill="none" />
        {g.dots.map((d, i) => (
          <circle key={i} className="chart-dot" cx={d.x} cy={d.y} r={4}>
            <title>Filled at {formatBps(d.bps)}</title>
          </circle>
        ))}
        <text className="chart-label" x={box.left} y={box.height - 8}>
          {axisTime(s.startedAt)}
        </text>
        <text className="chart-label" x={right} y={box.height - 8} textAnchor="end">
          {now < s.endsAt ? "now" : axisTime(s.endsAt)}
        </text>
      </svg>
    </div>
  );
}

/** Dutch auctions and how they sold, with each one's discount curve. */
export function AuctionsHistory({ client, selio, meta, range, mine }: HistoryPanelProps) {
  const { refreshKey } = useNetwork();
  const { address } = useWallet();
  const U = meta.underlying;
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const read = useAsync(
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const { sessions } = await client.auctions(selio.market, {
        since: rangeSince(range, now),
        seller: mine ?? undefined,
        limit: PAGE * pages,
      });
      return { sessions, now };
    },
    [client, selio, range, mine, pages],
    { pollMs: HISTORY_POLL_MS, reloadKey: refreshKey },
  );

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let body;
  if (read.error != null && !read.data) {
    body = <Notice tone="danger">Can't read auctions from the index: {describeError(read.error)}</Notice>;
  } else if (!read.data) {
    body = <p className="muted loading">Reading auctions…</p>;
  } else if (read.data.sessions.length === 0) {
    body = <p className="muted">{mine ? "You opened no auction in this range." : "No auction opened in this range."}</p>;
  } else {
    const { sessions, now } = read.data;
    body = (
      <>
        <div className="table-wrap">
          <table className="data data--wide" data-testid="history-auctions">
            <thead>
              <tr>
                <th scope="col">Auction</th>
                <th scope="col">Seller</th>
                <th scope="col">Opened</th>
                <th scope="col">Schedule</th>
                <th scope="col">Sold</th>
                <th scope="col">Average discount</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Discount curve</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const id = String(s.sessionId);
                const running = now < s.endsAt && s.listedAssets > 0n;
                const shown = open.has(id);
                return (
                  <Fragment key={id}>
                    <tr data-testid={`history-auction-row-${id}`}>
                      <td className="cell-title">Auction #{id}</td>
                      <td className="mono">{address && isAddressEqual(s.seller, address) ? "You" : shortAddress(s.seller)}</td>
                      <td className="mono">{axisTime(s.startedAt)}</td>
                      <td>
                        {formatBps(s.startBps)} rising {formatBps(s.stepBps)} every {formatDuration(s.stepInterval)}, cap{" "}
                        {formatBps(s.capBps)}
                      </td>
                      <td className="mono">
                        Sold {formatToken(s.soldAssets, U)} of {formatToken(s.openedAssets, U)}
                      </td>
                      <td className="mono">{s.avgDiscountBps === null ? "—" : formatBps(s.avgDiscountBps)}</td>
                      <td>
                        <Chip tone={running ? "open" : "neutral"}>{running ? "Running" : "Ended"}</Chip>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          aria-expanded={shown}
                          onClick={() => toggle(id)}
                          data-testid={`history-auction-toggle-${id}`}
                        >
                          {shown ? "Hide curve" : "Curve"}
                        </button>
                      </td>
                    </tr>
                    {shown && (
                      <tr>
                        <td colSpan={8}>
                          <DiscountCurve session={s} now={now} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {sessions.length === PAGE * pages && (
          <button
            type="button"
            className="btn btn--secondary btn--small self-start"
            onClick={() => setPages((p) => p + 1)}
            data-testid="history-more-auctions"
          >
            Show more
          </button>
        )}
      </>
    );
  }

  return (
    <section className="card card--pad stack" aria-labelledby="h-history-auctions">
      <h2 id="h-history-auctions" className="h2-sm">
        Auctions
      </h2>
      {body}
    </section>
  );
}
