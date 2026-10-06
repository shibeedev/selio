import { randomUUID } from "node:crypto";
import type { Transactional } from "../../shared/db/database.js";
import type { RateLimitPort } from "../../shared/db/rateLimits.js";
import { AppError } from "../../shared/errors/AppError.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { toNetworkKey } from "../../shared/utils/validation.js";
import type { CapacitySnapshot } from "../capacity/index.js";
import type { AlertRow } from "./alerts.model.js";
import type { AlertRepositoryPort } from "./alerts.repository.js";
import type { CreateAlertInput } from "./alerts.schema.js";
import {
  EVENTS_LIMIT,
  MAX_ALERTS_PER_OWNER,
  WEBHOOK_CONCURRENCY,
  WEBHOOK_OWNER_LIMIT,
  WEBHOOK_OWNER_WINDOW_MS,
  type Alert,
  type AlertDto,
  type AlertEventDto,
  type MaskedWebhook,
  type WebhookPayload,
  type WebhookSender,
} from "./alerts.types.js";

/** Edge-triggered: fires when utilization is at or above the threshold and was below it at the previous evaluation. */
export function shouldFire(previousBps: number | null, currentBps: number, thresholdBps: number): boolean {
  return currentBps >= thresholdBps && (previousBps === null || previousBps < thresholdBps);
}

export function maskWebhook(url: string | null): MaskedWebhook | null {
  if (url === null) return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = "";
  }
  return { host, last4: url.slice(-4) };
}

export interface AlertServiceOptions {
  /** Counters for the per-owner webhook rate; without them no per-owner rate applies. */
  limits?: RateLimitPort;
  maxAlertsPerOwner?: number;
  webhookConcurrency?: number;
  ownerLimit?: number;
  ownerWindowMs?: number;
}

interface Delivery {
  alertId: string;
  url: string;
  payload: WebhookPayload;
}

/** Runs `worker` over `items` with at most `size` in flight; a worker takes the next item when its last one settles. */
async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

export class AlertService {
  private readonly limits: RateLimitPort | undefined;
  private readonly maxAlertsPerOwner: number;
  private readonly webhookConcurrency: number;
  private readonly ownerLimit: number;
  private readonly ownerWindowMs: number;

  constructor(
    private readonly repo: AlertRepositoryPort,
    private readonly webhook: WebhookSender,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
    options: AlertServiceOptions = {},
  ) {
    this.limits = options.limits;
    this.maxAlertsPerOwner = options.maxAlertsPerOwner ?? MAX_ALERTS_PER_OWNER;
    this.webhookConcurrency = options.webhookConcurrency ?? WEBHOOK_CONCURRENCY;
    this.ownerLimit = options.ownerLimit ?? WEBHOOK_OWNER_LIMIT;
    this.ownerWindowMs = options.ownerWindowMs ?? WEBHOOK_OWNER_WINDOW_MS;
  }

  async createAlert(input: CreateAlertInput): Promise<Alert> {
    if (input.webhookUrl !== undefined) await this.webhook.checkTarget(input.webhookUrl);
    const row: AlertRow = {
      id: this.newId(),
      owner: input.owner,
      network: input.network,
      thresholdBps: input.thresholdBps,
      webhookUrl: input.webhookUrl ?? null,
      lastUtilizationBps: null,
      createdAt: this.now(),
    };
    this.inTransaction((tx) => {
      if (this.repo.countByOwner(row.owner, tx) >= this.maxAlertsPerOwner) {
        throw new AppError(
          409,
          "ALERT_LIMIT_REACHED",
          `An address can have at most ${this.maxAlertsPerOwner} alerts; delete one first`,
        );
      }
      this.repo.insert(row, tx);
    });
    this.logger.info({ alertId: row.id, network: row.network, thresholdBps: row.thresholdBps }, "alert created");
    return {
      id: row.id,
      owner: row.owner,
      network: input.network,
      thresholdBps: row.thresholdBps,
      webhookUrl: row.webhookUrl,
      createdAt: row.createdAt,
    };
  }

  getAlerts(owner: string): AlertDto[] {
    return this.repo.listByOwner(owner).map((a) => ({
      id: a.id,
      owner: a.owner,
      network: toNetworkKey(a.network),
      thresholdBps: a.thresholdBps,
      webhook: maskWebhook(a.webhookUrl),
      createdAt: a.createdAt,
    }));
  }

  deleteAlert(id: string, owner: string): void {
    const alert = this.repo.findById(id);
    if (!alert) throw new AppError(404, "ALERT_NOT_FOUND", `Alert ${id} not found`);
    if (alert.owner !== owner) throw new AppError(403, "FORBIDDEN", "Alert belongs to another owner");
    this.repo.delete(id);
    this.logger.info({ alertId: id }, "alert deleted");
  }

  getEvents(owner: string): AlertEventDto[] {
    return this.repo.listEventsByOwner(owner, EVENTS_LIMIT).map((e) => ({
      id: e.id,
      alertId: e.alertId,
      network: toNetworkKey(e.network),
      utilizationBps: e.utilizationBps,
      thresholdBps: e.thresholdBps,
      at: e.at,
    }));
  }

  /**
   * Records fired alerts as events, one transaction per snapshot, then delivers their webhooks after every snapshot
   * was evaluated. Delivery failures are only logged; the events stay.
   */
  async evaluateSnapshots(snapshots: CapacitySnapshot[]): Promise<void> {
    const deliveries: Delivery[] = [];
    for (const snap of snapshots) {
      const firing = this.inTransaction((tx) => {
        const alerts = this.repo.listByNetwork(snap.network, tx);
        const fired = alerts.filter((a) => shouldFire(a.lastUtilizationBps, snap.utilizationBps, a.thresholdBps));
        this.repo.insertEvents(
          fired.map((a) => ({
            alertId: a.id,
            owner: a.owner,
            network: a.network,
            utilizationBps: snap.utilizationBps,
            thresholdBps: a.thresholdBps,
            at: snap.at,
          })),
          tx,
        );
        this.repo.setLastUtilization(snap.network, snap.utilizationBps, tx);
        return fired;
      });
      for (const a of firing) {
        this.logger.info({ alertId: a.id, network: a.network, utilizationBps: snap.utilizationBps }, "alert fired");
        if (!a.webhookUrl) continue;
        if (this.limits && this.limits.hit(`webhook:${a.owner}`, this.ownerWindowMs, this.now()).hits > this.ownerLimit) {
          this.logger.warn({ alertId: a.id }, "webhook skipped");
          continue;
        }
        deliveries.push({
          alertId: a.id,
          url: a.webhookUrl,
          payload: {
            type: "selio.capacity.alert",
            network: snap.network,
            utilizationBps: snap.utilizationBps,
            thresholdBps: a.thresholdBps,
            withdrawable: snap.withdrawable.toString(),
            supplied: snap.supplied.toString(),
            at: snap.at,
          },
        });
      }
    }
    await runPool(deliveries, this.webhookConcurrency, async (d) => {
      try {
        await this.webhook.deliver(d.url, d.payload);
        this.logger.info({ alertId: d.alertId }, "webhook delivered");
      } catch (err) {
        this.logger.warn({ alertId: d.alertId, err }, "webhook delivery failed");
      }
    });
  }
}
