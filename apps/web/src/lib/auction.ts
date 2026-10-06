import type { SessionParams } from "@selio/sdk";

export interface DiscountCurve {
  startBps: number;
  stepBps: number;
  stepInterval: number;
  capBps: number;
}

/** Mirrors ExitMarket.discountOf. */
export function discountAt(curve: DiscountCurve, elapsedSeconds: number): number {
  if (curve.stepInterval <= 0) return curve.startBps;
  const steps = Math.floor(Math.max(0, elapsedSeconds) / curve.stepInterval);
  return Math.min(curve.capBps, curve.startBps + steps * curve.stepBps);
}

/** Seconds until the curve reaches `targetBps`, or null when it never does. */
export function secondsToReach(curve: DiscountCurve, targetBps: number): number | null {
  if (targetBps <= curve.startBps) return 0;
  if (targetBps > curve.capBps || curve.stepBps <= 0 || curve.stepInterval <= 0) return null;
  return Math.ceil((targetBps - curve.startBps) / curve.stepBps) * curve.stepInterval;
}

export interface SessionLimits {
  maxDiscountBps: number;
  maxDurationSeconds: number;
  payTokenCount: number;
}

/** Same checks as ExitMarket.openSession, in the same order. */
export function validateSessionParams(p: SessionParams, limits: SessionLimits): string | null {
  if (p.capBps > limits.maxDiscountBps) return `The cap can be at most ${limits.maxDiscountBps / 100}%`;
  if (p.startBps > p.capBps) return "The start discount must not exceed the cap";
  if (p.stepInterval <= 0) return "The discount must rise at some interval";
  if (p.duration <= 0) return "The auction needs a duration";
  if (p.duration > limits.maxDurationSeconds) {
    return `An auction can run at most ${Math.floor(limits.maxDurationSeconds / 86_400)} days`;
  }
  if (p.payMask === 0) return "Accept at least one payment asset";
  if (p.payMask >> limits.payTokenCount !== 0) return "Unknown payment asset";
  return null;
}
