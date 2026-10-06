import { describe, expect, it, vi } from "vitest";
import type { RateLimitPort } from "../../shared/db/rateLimits.js";
import { AppError } from "../../shared/errors/AppError.js";
import { directTransaction, OTHER_OWNER, OWNER, silentLogger } from "../../testing/fakes.js";
import type { CapacitySnapshot } from "../capacity/index.js";
import type { AlertEventRow, AlertRow, NewAlertEvent } from "./alerts.model.js";
import type { AlertRepositoryPort } from "./alerts.repository.js";
import { AlertService, shouldFire, type AlertServiceOptions } from "./alerts.service.js";
import type { WebhookPayload, WebhookSender } from "./alerts.types.js";

function memoryRepo() {
  const alerts: AlertRow[] = [];
  const events: AlertEventRow[] = [];
  const repo: AlertRepositoryPort = {
    insert: (a) => {
      alerts.push({ ...a });
    },
    findById: (id) => alerts.find((a) => a.id === id) ?? null,
    listByOwner: (owner) => alerts.filter((a) => a.owner === owner),
    listByNetwork: (network) => alerts.filter((a) => a.network === network),
    countByOwner: (owner) => alerts.filter((a) => a.owner === owner).length,
    delete: (id) => {
      const i = alerts.findIndex((a) => a.id === id);
      if (i >= 0) alerts.splice(i, 1);
    },
    setLastUtilization: (network, bps) => {
      for (const a of alerts) if (a.network === network) a.lastUtilizationBps = bps;
    },
    insertEvents: (rows: NewAlertEvent[]) =>
      rows.map((e) => {
        const row = { id: events.length + 1, ...e };
        events.push(row);
        return row;
      }),
    listEventsByOwner: (owner, limit) => events.filter((e) => e.owner === owner).slice(0, limit),
  };
  return { repo, alerts, events };
}

function alert(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "a1",
    owner: OWNER,
    network: "usdt0-replay",
    thresholdBps: 9_000,
    webhookUrl: null,
    lastUtilizationBps: null,
    createdAt: 0,
    ...overrides,
  };
}

function snapshot(utilizationBps: number, at: number): CapacitySnapshot {
  return { network: "usdt0-replay", at, utilizationBps, withdrawable: 5n, supplied: 100n };
}

function webhookMock(): WebhookSender & { deliver: ReturnType<typeof vi.fn>; checkTarget: ReturnType<typeof vi.fn> } {
  return {
    deliver: vi.fn(async (_url: string, _payload: WebhookPayload) => undefined),
    checkTarget: vi.fn(async (url: string) => ({ url, address: "203.0.113.10", family: 4 as const })),
  };
}

function service(repo: AlertRepositoryPort, webhook: WebhookSender, options: AlertServiceOptions = {}, now = () => 77) {
  return new AlertService(repo, webhook, directTransaction, silentLogger, now, () => "id-1", options);
}

describe("shouldFire", () => {
  it("fires only when crossing up through the threshold", () => {
    expect(shouldFire(8_999, 9_000, 9_000)).toBe(true);
    expect(shouldFire(9_000, 9_500, 9_000)).toBe(false);
    expect(shouldFire(9_500, 8_000, 9_000)).toBe(false);
    expect(shouldFire(8_000, 8_500, 9_000)).toBe(false);
  });

  it("fires on the first evaluation when already at or above", () => {
    expect(shouldFire(null, 9_999, 9_000)).toBe(true);
    expect(shouldFire(null, 8_000, 9_000)).toBe(false);
  });
});

describe("AlertService.evaluateSnapshots", () => {
  it("is edge-triggered across consecutive polls", async () => {
    const { repo, alerts, events } = memoryRepo();
    alerts.push(alert({ lastUtilizationBps: 8_000 }));
    const s = service(repo, webhookMock());
    for (const [i, bps] of [9_100, 9_900, 8_500, 9_000].entries()) await s.evaluateSnapshots([snapshot(bps, i + 1)]);
    expect(events.map((e) => e.at)).toEqual([1, 4]);
    expect(events[0]).toMatchObject({ utilizationBps: 9_100, thresholdBps: 9_000, owner: OWNER, alertId: "a1" });
  });

  it("fires once on the first snapshot when already above", async () => {
    const { repo, alerts, events } = memoryRepo();
    alerts.push(alert());
    const s = service(repo, webhookMock());
    await s.evaluateSnapshots([snapshot(9_999, 1)]);
    await s.evaluateSnapshots([snapshot(9_999, 2)]);
    expect(events).toHaveLength(1);
  });

  it("only evaluates alerts of the snapshot's network", async () => {
    const { repo, alerts, events } = memoryRepo();
    alerts.push(alert({ network: "vault-freeze" }));
    await service(repo, webhookMock()).evaluateSnapshots([snapshot(10_000, 1)]);
    expect(events).toHaveLength(0);
  });

  it("posts the webhook payload for fired alerts with a URL", async () => {
    const { repo, alerts } = memoryRepo();
    alerts.push(alert({ id: "with-url", webhookUrl: "https://hooks.example.com/x" }), alert({ id: "no-url" }));
    const webhook = webhookMock();
    await service(repo, webhook).evaluateSnapshots([snapshot(9_500, 42)]);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    expect(webhook.deliver).toHaveBeenCalledWith("https://hooks.example.com/x", {
      type: "selio.capacity.alert",
      network: "usdt0-replay",
      utilizationBps: 9_500,
      thresholdBps: 9_000,
      withdrawable: "5",
      supplied: "100",
      at: 42,
    });
  });

  it("keeps the event when webhook delivery fails", async () => {
    const { repo, alerts, events } = memoryRepo();
    alerts.push(alert({ webhookUrl: "https://hooks.example.com/x" }));
    const webhook = webhookMock();
    webhook.deliver.mockRejectedValue(new AppError(502, "UPSTREAM_ERROR", "Webhook delivery failed after 3 attempts (HTTP 500)"));
    await expect(service(repo, webhook).evaluateSnapshots([snapshot(9_500, 1)])).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it("runs at most WEBHOOK_CONCURRENCY deliveries at once", async () => {
    const { repo, alerts } = memoryRepo();
    for (let i = 0; i < 5; i++) alerts.push(alert({ id: `a${i}`, webhookUrl: `https://hooks.example.com/${i}` }));
    let pending = 0;
    let maxPending = 0;
    const webhook = webhookMock();
    webhook.deliver.mockImplementation(async () => {
      pending++;
      maxPending = Math.max(maxPending, pending);
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending--;
    });
    await service(repo, webhook, { webhookConcurrency: 2 }).evaluateSnapshots([snapshot(9_500, 1)]);
    expect(webhook.deliver).toHaveBeenCalledTimes(5);
    expect(maxPending).toBe(2);
  });

  it("skips webhooks beyond the per-owner rate and keeps every event", async () => {
    const { repo, alerts, events } = memoryRepo();
    alerts.push(
      alert({ id: "a1", webhookUrl: "https://hooks.example.com/1" }),
      alert({ id: "a2", webhookUrl: "https://hooks.example.com/2" }),
    );
    const counts = new Map<string, number>();
    const limits: RateLimitPort = {
      hit: (key) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { hits: counts.get(key) ?? 0, resetAt: 0 };
      },
    };
    const warn = vi.spyOn(silentLogger, "warn");
    const webhook = webhookMock();
    await service(repo, webhook, { limits, ownerLimit: 1 }).evaluateSnapshots([snapshot(9_500, 1)]);
    expect(events).toHaveLength(2);
    expect(webhook.deliver).toHaveBeenCalledTimes(1);
    expect(counts.get(`webhook:${OWNER}`)).toBe(2);
    expect(warn.mock.calls.filter((c) => c[1] === "webhook skipped")).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("AlertService CRUD", () => {
  it("creates alerts with a generated id and no evaluation yet", async () => {
    const { repo, alerts } = memoryRepo();
    const created = await service(repo, webhookMock()).createAlert({
      network: "usdt0-replay",
      thresholdBps: 9_500,
      owner: OWNER,
    });
    expect(created).toEqual({
      id: "id-1",
      owner: OWNER,
      network: "usdt0-replay",
      thresholdBps: 9_500,
      webhookUrl: null,
      createdAt: 77,
    });
    expect(alerts[0]?.lastUtilizationBps).toBeNull();
  });

  it("deletes only for the owner", async () => {
    const { repo, alerts } = memoryRepo();
    const s = service(repo, webhookMock());
    await s.createAlert({ network: "usdt0-replay", thresholdBps: 9_500, owner: OWNER });
    expect(() => s.deleteAlert("id-1", OTHER_OWNER)).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(() => s.deleteAlert("nope", OWNER)).toThrow(expect.objectContaining({ statusCode: 404 }));
    s.deleteAlert("id-1", OWNER);
    expect(alerts).toHaveLength(0);
  });

  it("refuses alerts beyond MAX_ALERTS_PER_OWNER", async () => {
    const { repo, alerts } = memoryRepo();
    let n = 0;
    const s = new AlertService(repo, webhookMock(), directTransaction, silentLogger, () => 1, () => `id-${++n}`, {
      maxAlertsPerOwner: 2,
    });
    const input = { network: "usdt0-replay" as const, thresholdBps: 9_000, owner: OWNER };
    await s.createAlert(input);
    await s.createAlert(input);
    await expect(s.createAlert(input)).rejects.toMatchObject({
      statusCode: 409,
      code: "ALERT_LIMIT_REACHED",
      message: "An address can have at most 2 alerts; delete one first",
    });
    await s.createAlert({ ...input, owner: OTHER_OWNER });
    expect(alerts).toHaveLength(3);
  });

  it("refuses webhooks the adapter rejects, before storing anything", async () => {
    const { repo } = memoryRepo();
    const insert = vi.spyOn(repo, "insert");
    const webhook = webhookMock();
    webhook.checkTarget.mockRejectedValue(
      new AppError(400, "WEBHOOK_NOT_ALLOWED", "webhookUrl host intranet.example resolves to a non-public address"),
    );
    await expect(
      service(repo, webhook).createAlert({
        network: "usdt0-replay",
        thresholdBps: 9_000,
        owner: OWNER,
        webhookUrl: "https://intranet.example/hook",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "WEBHOOK_NOT_ALLOWED" });
    expect(insert).not.toHaveBeenCalled();
  });
});
