import { verifySelioSignature } from "../../shared/crypto/signatures.js";
import type { Transactional } from "../../shared/db/database.js";
import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { ActionRepository } from "../executor/actions.repository.js";
import type { GrantRepository } from "../grants/grants.repository.js";
import { ALERT_TYPE, alertPayloadSchema, type AlertPayload } from "./triggers.schema.js";

export interface TriggerServiceOptions {
  /** The backend's WEBHOOK_SECRET. */
  webhookSecret: string;
  /** Minimum time between two actions of one grant (AGENT_COOLDOWN_MS). */
  cooldownMs: number;
}

export type TriggerResult = { status: 200; body: { duplicate: true } } | { status: 202; body: { queued: boolean } };

export class TriggerService {
  constructor(
    private readonly grants: GrantRepository,
    private readonly actions: ActionRepository,
    private readonly executor: { enqueue(actionId: number): void },
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly options: TriggerServiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * E.4: the webhook is a trigger, never an input. It is authenticated, matched to its grant and
   * de-duplicated; the action runs later, after an on-chain re-check, with amounts from the grant only.
   */
  onAlert(grantId: string, body: Buffer, signature: string | undefined): TriggerResult {
    if (!verifySelioSignature(this.options.webhookSecret, body, signature)) {
      throw new AppError(401, ErrorCode.BAD_SIGNATURE, "Invalid alert signature");
    }
    let payload: AlertPayload;
    try {
      payload = alertPayloadSchema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Not a Selio capacity alert");
    }
    const grant = this.grants.find(grantId);
    if (!grant) throw new AppError(404, ErrorCode.GRANT_NOT_FOUND, "Unknown grant");
    const now = this.now();
    if (grant.status === "active" && now >= grant.expiresAt) this.grants.setStatus(grant.id, "expired", now);
    if (grant.status !== "active" || now >= grant.expiresAt) {
      throw new AppError(410, ErrorCode.GRANT_INACTIVE, "This grant is no longer active");
    }
    if (payload.type !== ALERT_TYPE || payload.network !== grant.network || payload.thresholdBps !== grant.thresholdBps) {
      throw new AppError(422, ErrorCode.TRIGGER_MISMATCH, "The alert does not match this grant");
    }
    const outcome = this.inTransaction((tx) => {
      if (this.actions.exists(grant.id, grant.kind, payload.at, tx)) return { duplicate: true as const };
      const last = this.actions.lastStartedAt(grant.id, tx);
      const coolingDown = last !== null && now - last < this.options.cooldownMs;
      const id = this.actions.insert(
        {
          grantId: grant.id,
          kind: grant.kind,
          triggerAt: payload.at,
          utilizationBps: payload.utilizationBps,
          status: coolingDown ? "skipped" : "planned",
          message: coolingDown ? "Cooling down" : null,
        },
        now,
        tx,
      );
      return { duplicate: false as const, id: coolingDown ? null : id };
    });
    if (outcome.duplicate) return { status: 200, body: { duplicate: true } };
    if (outcome.id === null) {
      this.logger.info({ grantId: grant.id }, "trigger skipped: cooling down");
      return { status: 202, body: { queued: false } };
    }
    this.logger.info({ grantId: grant.id, actionId: outcome.id }, "trigger queued");
    this.executor.enqueue(outcome.id);
    return { status: 202, body: { queued: true } };
  }
}
