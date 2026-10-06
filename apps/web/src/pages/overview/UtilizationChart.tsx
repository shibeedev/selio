import { ApiError, getCapacityHistory } from "../../lib/api";
import { chartGeometry } from "../../lib/chart";
import { apiBaseUrl } from "../../lib/env";
import { describeError } from "../../lib/errors";
import { formatBps, formatDuration } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { poolTitle, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";

const BOX = { width: 640, height: 210, left: 48, right: 14, top: 18, bottom: 30 };

/** 24-hour utilization history from the backend, with the alert threshold being typed. */
export function UtilizationChart({ meta, currentBps, thresholdBps }: { meta: MarketMeta; currentBps?: number; thresholdBps?: number }) {
  const { key } = useNetwork();
  const history = useAsync(() => getCapacityHistory(key, 24), [key], { pollMs: 60_000 });
  const now = currentBps === undefined ? "…" : formatBps(currentBps);
  const nowBold = <b className="mono">{now}</b>;

  let body;
  if (history.error) {
    body = (
      <p className="chart-empty muted" data-testid="chart-unavailable">
        {history.error instanceof ApiError && history.error.offline
          ? `History comes from the Selio backend, which is unreachable at ${apiBaseUrl()}. `
          : `History is unavailable: ${describeError(history.error)} `}
        Utilization now: {nowBold}.
      </p>
    );
  } else if (!history.data) {
    body = <p className="chart-empty muted loading">Loading history…</p>;
  } else if (history.data.length === 0) {
    body = (
      <p className="chart-empty muted">
        No history recorded for this pool yet. Utilization now: {nowBold}.
      </p>
    );
  } else {
    const points = history.data;
    const threshold = thresholdBps !== undefined && thresholdBps <= 10_000 ? thresholdBps : undefined;
    const g = chartGeometry(points, BOX, threshold);
    const earliest = Math.min(...points.map((p) => p.t));
    const right = BOX.width - BOX.right;
    const bottom = BOX.height - BOX.bottom;
    body = (
      <svg
        className="chart"
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        width="100%"
        height={BOX.height}
        role="img"
        aria-label={`Utilization over the last 24 hours, now ${now}`}
        data-testid="utilization-chart"
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-fill-top)" />
            <stop offset="100%" stopColor="var(--chart-fill-bottom)" />
          </linearGradient>
        </defs>
        {g.ticks.map((tick) => (
          <g key={tick.label}>
            <line className="chart-grid" x1={BOX.left} x2={right} y1={tick.y} y2={tick.y} />
            <text className="chart-label" x={BOX.left - 8} y={tick.y + 4} textAnchor="end">
              {tick.label}
            </text>
          </g>
        ))}
        <line className="chart-axis" x1={BOX.left} x2={BOX.left} y1={BOX.top} y2={bottom} />
        {threshold !== undefined && (
          <g>
            <line className="chart-threshold" x1={BOX.left} x2={right} y1={g.yFor(threshold)} y2={g.yFor(threshold)} />
            <text className="chart-threshold-label" x={BOX.left + 8} y={g.yFor(threshold) - 6}>
              Your alert · {formatBps(threshold)}
            </text>
          </g>
        )}
        {points.length > 1 && g.last && (
          <polygon className="chart-area" points={`${g.polyline} ${g.last.x},${bottom} ${BOX.left},${bottom}`} fill="url(#chart-fill)" />
        )}
        <polyline className="chart-line" points={g.polyline} fill="none" />
        {g.last && <circle className="chart-dot" cx={g.last.x} cy={g.last.y} r={4} />}
        <text className="chart-label" x={BOX.left} y={202}>
          {formatDuration((Date.now() - earliest) / 1000)} ago
        </text>
        <text className="chart-label" x={right} y={202} textAnchor="end">
          now
        </text>
      </svg>
    );
  }

  return (
    <>
      <div className="panel-head">
        <h3 className="h3">Utilization, last 24 hours</h3>
        <span className="small muted">{poolTitle(meta)}</span>
      </div>
      {body}
    </>
  );
}
