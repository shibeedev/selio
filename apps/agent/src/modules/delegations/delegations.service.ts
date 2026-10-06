import { seal } from "../../shared/crypto/seal.js";
import { verifyDynamicEventSignature } from "../../shared/crypto/signatures.js";
import type { Db, Transactional } from "../../shared/db/database.js";
import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import { serializeKeyShare, type DynamicPort } from "../../shared/integrations/dynamic/dynamic.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { DelegationRow } from "./delegations.model.js";
import type { DelegationRepository } from "./delegations.repository.js";
import {
  delegationCreatedSchema,
  delegationRevokedSchema,
  eventEnvelopeSchema,
  eventTime,
  type EventEnvelope,
} from "./delegations.schema.js";

/** Revokes every grant of an address inside the caller's transaction (D.4). */
export interface GrantRevoker {
  revokeAllForAddress(address: string, now: number, tx: Db): void;
}

export interface DelegationServiceOptions {
  storageKey: Buffer;
  /** null while Dynamic is not configured: the webhook answers 503. */
  webhook: { environmentId: string; secret: string } | null;
  /** How long delivered event ids are kept for de-duplication. */
  eventRetentionMs?: number;
  /** Pruning of old event ids runs at most this often. */
  pruneEveryMs?: number;
}

/** Dynamic redelivers for up to a day on live environments; ids are kept three days. */
export const WEBHOOK_EVENT_RETENTION_MS = 3 * 24 * 3_600_000;

export class DelegationService {
  private lastPrune = 0;

  constructor(
    private readonly repo: DelegationRepository,
    private readonly grants: GrantRevoker,
    private readonly dynamic: Pick<DynamicPort, "decryptDelegation"> | null,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly options: DelegationServiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * POST /dynamic/webhooks: authenticates the raw body, then handles `wallet.delegation.created`,
   * `wallet.delegation.revoked` and `ping`. Every authentic event is acknowledged, including ignored ones.
   */
  handleWebhook(body: Buffer, signature: string | undefined): void {
    const webhook = this.options.webhook;
    if (!webhook || !this.dynamic) {
      throw new AppError(503, ErrorCode.DYNAMIC_NOT_CONFIGURED, "The exit agent is not configured yet");
    }
    if (!verifyDynamicEventSignature(webhook.secret, body, signature)) {
      throw new AppError(401, ErrorCode.BAD_SIGNATURE, "Invalid webhook signature");
    }
    this.prune();
    let envelope: EventEnvelope;
    try {
      envelope = eventEnvelopeSchema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      this.logger.warn("dynamic webhook ignored: not an event envelope");
      return;
    }
    if (envelope.environmentId !== webhook.environmentId) {
      this.logger.warn({ eventId: envelope.eventId }, "dynamic webhook ignored: other environment");
      return;
    }
    if (this.repo.hasEvent(envelope.eventId)) return;
    if (envelope.eventName === "wallet.delegation.created") this.onCreated(envelope, this.dynamic);
    else if (envelope.eventName === "wallet.delegation.revoked") this.onRevoked(envelope);
    else this.repo.recordEvent(envelope.eventId, envelope.eventName, this.now());
  }

  findLatestByAddress(address: string): DelegationRow | null {
    return this.repo.findLatestByAddress(address);
  }

  findByWalletId(walletId: string): DelegationRow | null {
    return this.repo.find(walletId);
  }

  /**
   * Ends a delegation from Selio's side: "revoked" (the user's revoke) from any state, "invalid"
   * (Dynamic refused the materials) only from active. Deletes the sealed materials and revokes every
   * grant of the address in the same transaction.
   */
  end(walletId: string, status: "revoked" | "invalid"): DelegationRow | null {
    const now = this.now();
    return this.inTransaction((tx) => {
      const row = this.repo.find(walletId, tx);
      if (!row || (status === "invalid" && row.status !== "active")) return row;
      this.repo.end(walletId, status, row.eventAt, now, tx);
      this.grants.revokeAllForAddress(row.address, now, tx);
      return this.repo.find(walletId, tx);
    });
  }

  private onCreated(envelope: EventEnvelope, dynamic: Pick<DynamicPort, "decryptDelegation">): void {
    const parsed = delegationCreatedSchema.safeParse(envelope.data);
    const userId = parsed.success ? (parsed.data.userId ?? envelope.userId) : null;
    if (!parsed.success || parsed.data.chain !== "EVM" || !userId) {
      this.logger.warn({ eventId: envelope.eventId }, "delegation event ignored: not an EVM delegation");
      this.repo.recordEvent(envelope.eventId, envelope.eventName, this.now());
      return;
    }
    const data = parsed.data;
    let sealedShare: string;
    let sealedApiKey: string;
    try {
      const { keyShare, walletApiKey } = dynamic.decryptDelegation({
        encryptedDelegatedShare: data.encryptedDelegatedShare,
        encryptedWalletApiKey: data.encryptedWalletApiKey,
      });
      sealedShare = seal(serializeKeyShare(keyShare), this.options.storageKey, data.walletId);
      sealedApiKey = seal(walletApiKey, this.options.storageKey, data.walletId);
    } catch {
      // Not recorded, so a redelivery after the key is fixed is processed.
      this.logger.error({ eventId: envelope.eventId, walletId: data.walletId }, "delegation could not be decrypted");
      return;
    }
    const eventAt = eventTime(envelope.timestamp);
    const now = this.now();
    const stored = this.inTransaction((tx) => {
      if (!this.repo.recordEvent(envelope.eventId, envelope.eventName, now, tx)) return false;
      const existing = this.repo.find(data.walletId, tx);
      // Dynamic does not guarantee ordering: an older event never overrides a newer state.
      if (existing && existing.eventAt > eventAt) return false;
      this.repo.save(
        {
          walletId: data.walletId,
          userId,
          address: data.publicKey.toLowerCase(),
          shareSetId: data.shareSetId ?? null,
          sealedShare,
          sealedApiKey,
          status: "active",
          eventAt,
        },
        now,
        tx,
      );
      return true;
    });
    if (stored) this.logger.info({ walletId: data.walletId, address: data.publicKey.toLowerCase() }, "delegation stored");
  }

  private onRevoked(envelope: EventEnvelope): void {
    const parsed = delegationRevokedSchema.safeParse(envelope.data);
    if (!parsed.success) {
      this.logger.warn({ eventId: envelope.eventId }, "delegation event ignored: no wallet id");
      this.repo.recordEvent(envelope.eventId, envelope.eventName, this.now());
      return;
    }
    const data = parsed.data;
    const eventAt = eventTime(envelope.timestamp);
    const now = this.now();
    const revoked = this.inTransaction((tx) => {
      if (!this.repo.recordEvent(envelope.eventId, envelope.eventName, now, tx)) return false;
      const existing = this.repo.find(data.walletId, tx);
      if (existing && existing.eventAt > eventAt) return false;
      if (existing) {
        this.repo.end(data.walletId, "revoked", eventAt, now, tx);
        this.grants.revokeAllForAddress(existing.address, now, tx);
      } else {
        // Revoked before created arrived: keep the revocation so the older created event is ignored.
        this.repo.save(
          {
            walletId: data.walletId,
            userId: data.userId ?? envelope.userId ?? "",
            address: (data.publicKey ?? "").toLowerCase(),
            shareSetId: null,
            sealedShare: null,
            sealedApiKey: null,
            status: "revoked",
            eventAt,
          },
          now,
          tx,
        );
      }
      return true;
    });
    if (revoked) this.logger.info({ walletId: data.walletId }, "delegation revoked by Dynamic");
  }

  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < (this.options.pruneEveryMs ?? 60_000)) return;
    this.lastPrune = now;
    this.repo.pruneEvents(now - (this.options.eventRetentionMs ?? WEBHOOK_EVENT_RETENTION_MS));
  }
}

export type DelegationPort = Pick<DelegationService, "findLatestByAddress" | "findByWalletId" | "end">;
