import { useCallback, useRef, useState, type RefCallback } from "react";
import { isAddressEqual } from "viem";
import type { IndexedCapacityPoint } from "@selio/sdk";
import { Notice } from "../../components/ui";
import { amountChartGeometry, chartGeometry, type AmountSeries, type ChartBox } from "../../lib/chart";
import { describeError } from "../../lib/errors";
import { formatBps } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { filledBuckets, HISTORY_POLL_MS, HISTORY_RANGES, rangeSince } from "../../lib/indexer";
import { useNetwork } from "../../lib/network-context";
import type { HistoryPanelProps } from "./HistoryPage";

const BASE_BOX: ChartBox = { width: 640, height: 210, left: 76, right: 14, top: 18, bottom: 30 };

/**
 * A chart box as wide as its container, measured, so SVG text keeps its size on phones and wide screens alike
 * instead of scaling with the viewBox.
 */
export function useChartBox(): [RefCallback<HTMLDivElement>, ChartBox] {
  const [width, setWidth] = useState(BASE_BOX.width);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const update = () => setWidth(Math.max(260, Math.floor(el.clientWidth)));
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(el);
  }, []);
  return [ref, { ...BASE_BOX, width }];
}

/** Bucket start (Unix seconds) as a short local date and time, for chart axes and table cells. */
export function axisTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export interface ChartLine<P> extends AmountSeries<P> {
  label: string;
  color: string;
}

/** Step-after lines of amounts over time, on the utilization chart's grid, axis and label styles. */
export function AmountChart<P extends { t: number }>({
  points,
  lines,
  decimals,
  label,
  testid,
  fromData,
  maxDecimals,
}: {
  points: readonly P[];
  lines: readonly ChartLine<P>[];
  decimals: number;
  label: string;
  testid: string;
  fromData?: boolean;
  maxDecimals?: number;
}) {
  const [ref, box] = useChartBox();
  const g = amountChartGeometry(points, lines, box, decimals, { fromData, maxDecimals });
  const right = box.width - box.right;
  const bottom = box.height - box.bottom;
  const first = points[0]?.t;
  return (
    <div className="stack-xs" ref={ref}>
      <svg
        className="chart"
        viewBox={`0 0 ${box.width} ${box.height}`}
        width="100%"
        height={box.height}
        role="img"
        aria-label={label}
        data-testid={testid}
      >
        {g.ticks.map((tick) => (
          <g key={tick.y}>
            <line className="chart-grid" x1={box.left} x2={right} y1={tick.y} y2={tick.y} />
            <text className="chart-label" x={box.left - 8} y={tick.y + 4} textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}
        <line className="chart-axis" x1={box.left} x2={box.left} y1={box.top} y2={bottom} />
        {g.lines.map((line, i) => (
          <polyline key={line.key} className="chart-line" points={line.points} fill="none" style={{ stroke: lines[i]?.color }} />
        ))}
        {first !== undefined && (
          <text className="chart-label" x={box.left} y={box.height - 8}>
            {axisTime(first)}
          </text>
        )}
        <text className="chart-label" x={right} y={box.height - 8} textAnchor="end">
          now
        </text>
      </svg>
      <p className="legend">
        {lines.map((line, i) => (
          <span key={line.key}>
            {i > 0 && " · "}
            <span style={{ color: line.color }} aria-hidden="true">
              ━
            </span>{" "}
            {line.label}
          </span>
        ))}
      </p>
    </div>
  );
}

function UtilizationOverTime({ buckets }: { buckets: readonly Bucket[] }) {
  const [ref, box] = useChartBox();
  const g = chartGeometry(
    buckets.map((b) => ({ t: b.t, utilizationBps: b.p.utilizationBps })),
    box,
  );
  const right = box.width - box.right;
  const bottom = box.height - box.bottom;
  const latest = buckets[buckets.length - 1];
  return (
    <div ref={ref}>
      <svg
        className="chart"
        viewBox={`0 0 ${box.width} ${box.height}`}
        width="100%"
        height={box.height}
        role="img"
        aria-label={`Utilization over time, latest ${latest ? formatBps(latest.p.utilizationBps) : "—"}`}
        data-testid="history-utilization-chart"
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
        <polyline className="chart-line" points={g.polyline} fill="none" />
        {g.last && <circle className="chart-dot" cx={g.last.x} cy={g.last.y} r={4} />}
        {buckets[0] && (
          <text className="chart-label" x={box.left} y={box.height - 8}>
            {axisTime(buckets[0].t)}
          </text>
        )}
        <text className="chart-label" x={right} y={box.height - 8} textAnchor="end">
          now
        </text>
      </svg>
    </div>
  );
}

type Bucket = { t: number; p: IndexedCapacityPoint };

const ROUTES: ChartLine<Bucket>[] = [
  { key: "withdrawable", label: "Withdrawable now", color: "var(--series-1)", value: (b) => b.p.withdrawable },
  { key: "debtors", label: "Exit via borrowers", color: "var(--series-3)", value: (b) => b.p.debtorCapacity },
  { key: "bids", label: "Bids at up to 20% off", color: "var(--series-5)", value: (b) => b.p.bidAt2000 },
];

const DEPTH: ChartLine<Bucket>[] = [
  { key: "100", label: "≤ 1%", color: "var(--series-1)", value: (b) => b.p.bidAt100 },
  { key: "300", label: "≤ 3%", color: "var(--series-2)", value: (b) => b.p.bidAt300 },
  { key: "500", label: "≤ 5%", color: "var(--series-3)", value: (b) => b.p.bidAt500 },
  { key: "1000", label: "≤ 10%", color: "var(--series-4)", value: (b) => b.p.bidAt1000 },
  { key: "2000", label: "≤ 20%", color: "var(--series-5)", value: (b) => b.p.bidAt2000 },
];

/** Utilization, exit routes and bid depth over time, reconstructed by the index from on-chain events. */
export function CapacityHistory({ client, selio, meta, range }: HistoryPanelProps) {
  const { refreshKey } = useNetwork();
  const U = meta.underlying;
  const { interval } = HISTORY_RANGES[range];
  const read = useAsync(
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const since = rangeSince(range, now);
      const { seed, points } = await client.capacity(selio.market, { interval, since });
      return { buckets: filledBuckets(seed, points, since, now, interval) };
    },
    [client, selio, range],
    { pollMs: HISTORY_POLL_MS, reloadKey: refreshKey },
  );

  let body;
  if (read.error != null && !read.data) {
    body = <Notice tone="danger">Can't read exit capacity from the index: {describeError(read.error)}</Notice>;
  } else if (!read.data) {
    body = <p className="muted loading">Reading exit capacity over time…</p>;
  } else if (read.data.buckets.length === 0) {
    body = <p className="muted">No exit capacity recorded in this range yet.</p>;
  } else {
    const buckets: Bucket[] = read.data.buckets.map((b) => ({ t: b.start, p: b.point }));
    const inexact = buckets.some((b) => !b.p.bidCapacityExact);
    const others = meta.payTokens.filter((t) => !isAddressEqual(t.address, U.address)).map((t) => t.symbol);
    body = (
      <>
        <div className="split split--top">
          <div className="panel">
            <h3 className="h3">Utilization over time</h3>
            <UtilizationOverTime buckets={buckets} />
          </div>
          <div className="panel">
            <h3 className="h3">Exit routes over time</h3>
            <AmountChart points={buckets} lines={ROUTES} decimals={U.decimals} label="Exit routes over time" testid="history-routes-chart" />
          </div>
        </div>
        <div className="panel">
          <h3 className="h3">Bid depth over time</h3>
          <AmountChart
            points={buckets}
            lines={DEPTH}
            decimals={U.decimals}
            label="Escrowed bids by the highest discount they accept"
            testid="history-depth-chart"
          />
        </div>
        <p className="legend">
          Amounts in {U.symbol} face value. Reconstructed from on-chain events: interest not yet accrued and tokens sent to the
          vault directly are left out.
          {inexact && others.length > 0 && ` Bids paid in ${others.join(", ")} count at their full remaining size.`}
        </p>
      </>
    );
  }

  return (
    <section className="card card--pad stack" aria-labelledby="h-history-capacity">
      <h2 id="h-history-capacity" className="h2-sm">
        Exit capacity
      </h2>
      {body}
    </section>
  );
}
