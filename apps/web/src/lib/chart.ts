import { formatAmount, formatBps } from "./format";

export interface UtilPoint {
  t: number;
  utilizationBps: number;
}

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartGeometry {
  polyline: string;
  last: { x: number; y: number } | null;
  ticks: { y: number; label: string }[];
  yFor(bps: number): number;
  minBps: number;
  maxBps: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Utilization line chart geometry: the y axis runs from a multiple of 5% below the data up to 100%. */
export function chartGeometry(points: readonly UtilPoint[], box: ChartBox, thresholdBps?: number): ChartGeometry {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const values = sorted.map((p) => p.utilizationBps);
  if (thresholdBps !== undefined) values.push(thresholdBps);
  const lowest = values.length ? Math.min(...values) : 8_000;
  const minBps = Math.max(0, Math.min(9_500, Math.floor((lowest - 100) / 500) * 500));
  const maxBps = 10_000;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;

  const rawY = (bps: number) => {
    const clamped = Math.min(maxBps, Math.max(minBps, bps));
    return box.top + plotH - ((clamped - minBps) / (maxBps - minBps)) * plotH;
  };
  const t0 = sorted[0]?.t ?? 0;
  const span = (sorted[sorted.length - 1]?.t ?? 0) - t0;
  const rawX = (t: number) => (sorted.length < 2 ? box.left + plotW : box.left + ((t - t0) / (span > 0 ? span : 1)) * plotW);

  const coords = sorted.map((p) => ({ x: round1(rawX(p.t)), y: round1(rawY(p.utilizationBps)) }));
  const step = maxBps - minBps > 2_000 ? 1_000 : 500;
  const ticks: { y: number; label: string }[] = [];
  for (let bps = minBps; bps <= maxBps; bps += step) ticks.push({ y: round1(rawY(bps)), label: `${bps / 100}%` });

  return {
    polyline: coords.map((c) => `${c.x},${c.y}`).join(" "),
    last: coords[coords.length - 1] ?? null,
    ticks,
    yFor: (bps: number) => round1(rawY(bps)),
    minBps,
    maxBps,
  };
}

export interface AmountSeries<P> {
  key: string;
  value(point: P): bigint;
}

export interface AmountChartGeometry {
  /** One step-after line per series, in series order. */
  lines: { key: string; points: string; last: { x: number; y: number } | null }[];
  ticks: { y: number; label: string }[];
  max: bigint;
}

/**
 * Amount chart geometry (exit routes, bid depth, share value): y runs from 0 to the largest value (one whole
 * token when every value is 0) with ticks at 0, 25, 50, 75 and 100% of it, x as in the utilization chart, and
 * each line steps after its points, since a value holds until the next one. `fromData` starts the scale at the
 * smallest value instead, for a value that moves little around a large level (the vault's share value).
 */
export function amountChartGeometry<P extends { t: number }>(
  points: readonly P[],
  series: readonly AmountSeries<P>[],
  box: ChartBox,
  decimals: number,
  opts: { fromData?: boolean; maxDecimals?: number } = {},
): AmountChartGeometry {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let max = 0n;
  let min: bigint | null = null;
  for (const p of sorted) {
    for (const s of series) {
      const v = s.value(p);
      if (v > max) max = v;
      if (min === null || v < min) min = v;
    }
  }
  if (max === 0n) max = 10n ** BigInt(decimals);
  let lo = 0n;
  if (opts.fromData && min !== null) {
    // A flat line still gets a visible span: 0.1% below its value.
    const below = min / 1_000n > 0n ? min / 1_000n : 1n;
    lo = min < max ? min : min - below;
  }
  const range = max - lo;
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const t0 = sorted[0]?.t ?? 0;
  const span = (sorted[sorted.length - 1]?.t ?? 0) - t0;
  const x = (t: number) => round1(sorted.length < 2 ? box.left + plotW : box.left + ((t - t0) / (span > 0 ? span : 1)) * plotW);
  const y = (v: bigint) => {
    const clamped = v < lo ? lo : v > max ? max : v;
    return round1(box.top + plotH - (Number(((clamped - lo) * 1_000_000n) / range) / 1_000_000) * plotH);
  };
  const lines = series.map((s) => {
    const coords: string[] = [];
    let previous: number | null = null;
    for (const p of sorted) {
      const px = x(p.t);
      const py = y(s.value(p));
      if (previous !== null) coords.push(`${px},${previous}`);
      coords.push(`${px},${py}`);
      previous = py;
    }
    const lastPoint = sorted[sorted.length - 1];
    return { key: s.key, points: coords.join(" "), last: lastPoint ? { x: x(lastPoint.t), y: y(s.value(lastPoint)) } : null };
  });
  // Whole units label a scale of a thousand units or more, so long tick labels fit the axis margin.
  const tickDecimals = opts.maxDecimals ?? (range >= 1_000n * 10n ** BigInt(decimals) ? 0 : undefined);
  const ticks = [0n, 1n, 2n, 3n, 4n].map((k) => {
    const v = lo + (range * k) / 4n;
    return { y: y(v), label: formatAmount(v, decimals, tickDecimals) };
  });
  return { lines, ticks, max };
}

export interface CurveSession {
  startedAt: number;
  endsAt: number;
  startBps: number;
  stepBps: number;
  stepInterval: number;
  capBps: number;
  fills: readonly { timestamp: number; discountBps: number }[];
}

/**
 * An auction's discount schedule as a step line from its start to the earlier of its end and `until` (seconds),
 * with a dot per fill; y runs from 0 to the cap (or the highest fill).
 */
export function discountCurveGeometry(
  s: CurveSession,
  until: number,
  box: ChartBox,
): { points: string; dots: { x: number; y: number; bps: number }[]; ticks: { y: number; label: string }[] } {
  const end = Math.max(s.startedAt + 1, Math.min(s.endsAt, until));
  const maxBps = Math.max(100, s.capBps, ...s.fills.map((f) => f.discountBps));
  const plotW = box.width - box.left - box.right;
  const plotH = box.height - box.top - box.bottom;
  const x = (t: number) => round1(box.left + (Math.min(Math.max(t, s.startedAt), end) - s.startedAt) / (end - s.startedAt) * plotW);
  const y = (bps: number) => round1(box.top + plotH - (Math.min(Math.max(bps, 0), maxBps) / maxBps) * plotH);
  let current = Math.min(s.startBps, s.capBps);
  const coords = [`${x(s.startedAt)},${y(current)}`];
  if (s.stepBps > 0 && s.stepInterval > 0) {
    const toCap = Math.ceil((s.capBps - current) / s.stepBps);
    const elapsed = Math.floor((end - s.startedAt) / s.stepInterval);
    for (let k = 1; k <= Math.min(toCap, elapsed); k++) {
      const t = s.startedAt + k * s.stepInterval;
      if (t >= end) break;
      const next = Math.min(s.capBps, s.startBps + k * s.stepBps);
      coords.push(`${x(t)},${y(current)}`, `${x(t)},${y(next)}`);
      current = next;
    }
  }
  coords.push(`${x(end)},${y(current)}`);
  return {
    points: coords.join(" "),
    dots: s.fills.map((f) => ({ x: x(f.timestamp), y: y(f.discountBps), bps: f.discountBps })),
    ticks: [0, maxBps / 2, maxBps].map((bps) => ({ y: y(bps), label: formatBps(Math.round(bps)) })),
  };
}
