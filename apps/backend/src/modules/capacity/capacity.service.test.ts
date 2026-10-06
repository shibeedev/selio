import { afterEach, describe, expect, it, vi } from "vitest";
import { directTransaction, reading, silentLogger } from "../../testing/fakes.js";
import type { CapacitySnapshotRow } from "./capacity.model.js";
import { CapacityPoller } from "./capacity.poller.js";
import { CapacityService, toHistoryPoints, type CapacityChainPort } from "./capacity.service.js";

const HOUR = 3_600_000;

function row(at: number): CapacitySnapshotRow {
  return {
    id: at,
    network: "usdt0-replay",
    at,
    utilizationBps: 9_000 + at,
    withdrawable: String(at),
    supplied: "100",
    debtorCapacity: "7",
    sessionAssets: "0",
  };
}

function repoMock() {
  return { insertMany: vi.fn(), listSince: vi.fn((): CapacitySnapshotRow[] => []), deleteOlderThan: vi.fn(() => 0) };
}

describe("toHistoryPoints", () => {
  it("returns chart points oldest first with amounts as strings", () => {
    expect(toHistoryPoints([row(30), row(10), row(20)])).toEqual([
      { t: 10, utilizationBps: 9_010, withdrawable: "10", supplied: "100" },
      { t: 20, utilizationBps: 9_020, withdrawable: "20", supplied: "100" },
      { t: 30, utilizationBps: 9_030, withdrawable: "30", supplied: "100" },
    ]);
  });
});

describe("CapacityService", () => {
  it("serves live capacity with bigints as decimal strings", async () => {
    const readCapacity = vi.fn(async (_key: string, levels: readonly number[]) =>
      reading(9_500, {
        supplied: 10n ** 30n,
        bidCapacity: levels.map((d) => ({ discountBps: d, assets: BigInt(d) })),
      }),
    );
    const chain: CapacityChainPort = { readCapacity, deployedNetworks: () => [] };
    const service = new CapacityService(repoMock(), chain, directTransaction, silentLogger, () => 5);
    const dto = await service.getCapacity("usdt0-replay");
    expect(readCapacity).toHaveBeenCalledWith("usdt0-replay", [100, 300, 500, 1000, 2000]);
    expect(dto.at).toBe(5);
    expect(dto.supplied).toBe("1000000000000000000000000000000");
    expect(dto.withdrawable).toBe("100000000000000000");
    expect(dto.utilizationBps).toBe(9_500);
    expect(dto.bidCapacity.map((b) => b.discountBps)).toEqual([100, 300, 500, 1000, 2000]);
    expect(dto.bidCapacity[0]).toEqual({ discountBps: 100, assets: "100" });
    expect(Object.keys(dto)).toEqual([
      "network",
      "at",
      "underlying",
      "withdrawable",
      "supplied",
      "utilizationBps",
      "debtorCapacity",
      "sessionAssets",
      "bidCapacity",
    ]);
  });

  it("reads history inside the requested window", () => {
    const repo = repoMock();
    const chain: CapacityChainPort = { readCapacity: vi.fn(), deployedNetworks: () => [] };
    const service = new CapacityService(repo, chain, directTransaction, silentLogger, () => 10 * HOUR);
    service.getHistory("usdt0-replay", 6);
    expect(repo.listSince).toHaveBeenCalledWith("usdt0-replay", 4 * HOUR);
  });

  it("snapshots every deployed network, skips failing RPCs and prunes old history", async () => {
    const repo = repoMock();
    const chain: CapacityChainPort = {
      deployedNetworks: () => ["usdt0-replay", "vault-freeze"],
      readCapacity: vi.fn(async (key: string) => {
        if (key === "vault-freeze") throw new Error("HTTP request failed.");
        return reading(9_999);
      }),
    };
    const service = new CapacityService(repo, chain, directTransaction, silentLogger, () => 200 * HOUR);
    const snapshots = await service.snapshotAll();
    expect(chain.readCapacity).toHaveBeenCalledWith("usdt0-replay", []);
    expect(snapshots).toEqual([
      { network: "usdt0-replay", at: 200 * HOUR, utilizationBps: 9_999, withdrawable: 10n ** 17n, supplied: 10n ** 21n },
    ]);
    expect(repo.insertMany).toHaveBeenCalledWith(
      [
        {
          network: "usdt0-replay",
          at: 200 * HOUR,
          utilizationBps: 9_999,
          withdrawable: "100000000000000000",
          supplied: "1000000000000000000000",
          debtorCapacity: "200000000000000000000",
          sessionAssets: "0",
        },
      ],
      undefined,
    );
    expect(repo.deleteOlderThan).toHaveBeenCalledWith(32 * HOUR, undefined);
  });
});

describe("CapacityPoller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes each round to every listener and survives listener errors", async () => {
    const snapshots = [{ network: "usdt0-replay" as const, at: 1, utilizationBps: 1, withdrawable: 1n, supplied: 2n }];
    const first = vi.fn(async () => {
      throw new Error("listener down");
    });
    const second = vi.fn();
    const poller = new CapacityPoller(async () => snapshots, [first, second], 60_000, silentLogger);
    poller.start();
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(snapshots));
    expect(first).toHaveBeenCalledTimes(1);
    await poller.stop();
  });

  it("starts immediately and stops cleanly", async () => {
    vi.useFakeTimers();
    const snapshot = vi.fn(async () => []);
    const poller = new CapacityPoller(snapshot, [], 1_000, silentLogger);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(snapshot).toHaveBeenCalledTimes(2);
    await poller.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});
