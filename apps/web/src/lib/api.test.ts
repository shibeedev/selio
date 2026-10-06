import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, FAUCET_TIMEOUT_MS, requestDemoFunds } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("demo faucet client", () => {
  it("returns the steps the backend reports", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, actions: ["Funded", "Deposited", "Re-froze"] })));
    expect(await requestDemoFunds("usdt0-replay", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "seller")).toEqual([
      "Funded",
      "Deposited",
      "Re-froze",
    ]);
  });

  it("refuses an answer without ok: true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ actions: [] })));
    await expect(requestDemoFunds("usdt0-replay", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "bidder")).rejects.toThrow(
      "The faucet did not confirm the transfer.",
    );
  });

  it("reports a kit that outlasts the wait as still running, not as an unreachable backend", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      ),
    );
    const pending = requestDemoFunds("vault-freeze", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "seller").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FAUCET_TIMEOUT_MS);
    const err = (await pending) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.offline).toBe(false);
    expect(err.message).toMatch(/still running/);
    expect(err.message).not.toMatch(/fail|error|limit/i);
    expect(FAUCET_TIMEOUT_MS).toBeGreaterThan(60_000 + 120_000);
  });

  it("calls a backend it cannot reach unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const err = (await requestDemoFunds("usdt0-replay", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "seller").catch((e: unknown) => e)) as ApiError;
    expect(err.offline).toBe(true);
    expect(err.message).toMatch(/unreachable/);
  });
});
