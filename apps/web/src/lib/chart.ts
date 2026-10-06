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
