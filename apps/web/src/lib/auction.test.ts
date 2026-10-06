import { describe, expect, it } from "vitest";
import { discountAt, secondsToReach, validateSessionParams } from "./auction";

const curve = { startBps: 50, stepBps: 25, stepInterval: 900, capBps: 500 };
const limits = { maxDiscountBps: 5_000, maxDurationSeconds: 30 * 86_400, payTokenCount: 3 };
const sane = { startBps: 50, stepBps: 25, stepInterval: 900, capBps: 500, duration: 86_400, payMask: 0b111 };

describe("discount curve", () => {
  it("steps up every interval and stops at the cap", () => {
    expect(discountAt(curve, 0)).toBe(50);
    expect(discountAt(curve, 899)).toBe(50);
    expect(discountAt(curve, 900)).toBe(75);
    expect(discountAt(curve, 10 * 86_400)).toBe(500);
  });

  it("tells when a discount is reached", () => {
    expect(secondsToReach(curve, 300)).toBe(9_000);
    expect(secondsToReach(curve, 40)).toBe(0);
    expect(secondsToReach(curve, 600)).toBeNull();
    expect(secondsToReach({ ...curve, stepBps: 0 }, 300)).toBeNull();
  });
});

describe("validateSessionParams", () => {
  it("accepts sane parameters", () => {
    expect(validateSessionParams(sane, limits)).toBeNull();
  });

  it("applies the contract's checks in order", () => {
    expect(validateSessionParams({ ...sane, capBps: 6_000 }, limits)).toMatch(/cap/);
    expect(validateSessionParams({ ...sane, startBps: 600 }, limits)).toMatch(/start/);
    expect(validateSessionParams({ ...sane, stepInterval: 0 }, limits)).toMatch(/interval/);
    expect(validateSessionParams({ ...sane, duration: 31 * 86_400 }, limits)).toMatch(/30 days/);
    expect(validateSessionParams({ ...sane, payMask: 0 }, limits)).toMatch(/payment/);
    expect(validateSessionParams({ ...sane, payMask: 0b1000 }, limits)).toMatch(/Unknown/);
  });
});
