import { ZodError, z } from "zod";
import type { Transactional } from "../../shared/db/database.js";
import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import type { DynamicPort } from "../../shared/integrations/dynamic/dynamic.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { DynamicUser } from "../../shared/middlewares/requireDynamicUser.js";
import type { DelegationPort, DelegationRow } from "../delegations/index.js";
import type { ActionRepository } from "../executor/actions.repository.js";
import type { GrantRepository } from "./grants.repository.js";
import type { CreateGrantInput } from "./grants.schema.js";
import { ACTIONS_LIMIT, toActionDto, toGrantDto, type MeDto } from "./grants.types.js";

export interface GrantServiceOptions {
  /** Longest grant lifetime (MAX_GRANT_MS). */
  maxGrantMs: number;
}

const forbidden = () => new AppError(403, ErrorCode.FORBIDDEN, "This wallet is not held by your sign-in");

export class GrantService {
  constructor(
    private readonly grants: GrantRepository,
    private readonly actions: ActionRepository,
    private readonly delegations: DelegationPort,
    private readonly executor: { enqueue(actionId: number): void },
    private readonly dynamic: Pick<DynamicPort, "revokeDelegatedAccess"> | null,
    /** Number of pay tokens of the monad-testnet market (from its deployment). */
    private readonly payTokenCount: () => number,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly options: GrantServiceOptions,
    private readonly now: () => number = Date.now,
  ) {}

  me(user: DynamicUser): MeDto {
    const { address, delegation } = this.walletOf(user);
    this.grants.expireDue(address, this.now());
    return {
      address,
      delegation: delegation ? { status: delegation.status, since: delegation.updatedAt } : null,
      grants: this.grants.listByAddress(address).map(toGrantDto),
      actions: this.actions.listForAddress(address, ACTIONS_LIMIT).map(toActionDto),
    };
  }

  create(user: DynamicUser, input: CreateGrantInput): { id: string } {
    const { address, delegation } = this.walletOf(user);
    if (!delegation || delegation.status !== "active") {
      throw new AppError(409, ErrorCode.DELEGATION_REQUIRED, "Allow the exit agent for this wallet first");
    }
    if (delegation.userId !== user.userId) throw forbidden();
    const now = this.now();
    const payTokens = this.payTokenCount();
    this.checkBounds(input, now, payTokens);
    this.inTransaction((tx) => {
      if (this.grants.find(input.id, tx)) throw new AppError(409, ErrorCode.GRANT_ID_TAKEN, "This grant id is already in use");
      this.grants.expireDue(address, now, tx);
      if (this.grants.findActive(address, input.network, input.kind, tx)) {
        throw new AppError(409, ErrorCode.GRANT_EXISTS, `An active ${input.kind} grant exists for this wallet; delete it first`);
      }
      this.grants.insert(
        {
          id: input.id,
          address,
          userId: user.userId,
          network: input.network,
          kind: input.kind,
          alertId: input.alertId,
          thresholdBps: input.thresholdBps,
          maxPerAction: BigInt(input.maxPerAction),
          maxTotal: BigInt(input.maxTotal),
          usedTotal: 0n,
          maxSellDiscountBps: input.kind === "sell" ? input.maxSellDiscountBps : null,
          payMask: input.kind === "sell" ? (input.payMask ?? (1 << payTokens) - 1) : null,
          minBidDiscountBps: input.kind === "bid" ? input.minBidDiscountBps : null,
          payIdx: input.kind === "bid" ? input.payIdx : null,
          expiresAt: input.expiresAt,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        tx,
      );
    });
    this.logger.info({ grantId: input.id, kind: input.kind, address }, "grant created");
    return { id: input.id };
  }

  /** Revokes one grant; with `cancelBid` and an active delegation the agent then cancels its standing bid. */
  remove(user: DynamicUser, id: string, cancelBid: boolean): void {
    const grant = this.grants.find(id);
    if (!grant) throw new AppError(404, ErrorCode.GRANT_NOT_FOUND, "Unknown grant");
    if (!user.addresses.includes(grant.address) || grant.userId !== user.userId) throw forbidden();
    const delegation = this.delegations.findLatestByAddress(grant.address);
    if (delegation && delegation.userId !== user.userId) throw forbidden();
    const now = this.now();
    const cancelId = this.inTransaction((tx) => {
      if (grant.status !== "revoked") this.grants.setStatus(id, "revoked", now, tx);
      const hasBid = grant.kind === "bid" && this.actions.latestDoneBidId(id, tx) !== null;
      if (!cancelBid || !hasBid || delegation?.status !== "active") return null;
      return this.actions.insert(
        { grantId: id, kind: "cancel", triggerAt: 0, utilizationBps: null, status: "planned", message: null },
        now,
        tx,
      );
    });
    if (cancelId !== null) this.executor.enqueue(cancelId);
    this.logger.info({ grantId: id, cancelBid: cancelId !== null }, "grant deleted");
  }

  /**
   * Takes effect before it returns: the delegation is revoked, its sealed materials deleted and every
   * grant of the wallet revoked; then Dynamic's admin endpoint is asked to revoke too (best effort).
   */
  async revoke(user: DynamicUser): Promise<{ revoked: true; dynamicRevoked: boolean }> {
    const { address, delegation } = this.walletOf(user);
    if (delegation && delegation.userId !== user.userId) throw forbidden();
    if (delegation) this.delegations.end(delegation.walletId, "revoked");
    else this.inTransaction((tx) => this.grants.revokeAllForAddress(address, this.now(), tx));
    const dynamicRevoked = delegation && this.dynamic ? await this.dynamic.revokeDelegatedAccess(delegation.walletId) : false;
    this.logger.info({ address, dynamicRevoked }, "agent revoked");
    return { revoked: true, dynamicRevoked };
  }

  /** The token's first EVM address that has a delegation row, else its first EVM address. */
  private walletOf(user: DynamicUser): { address: string; delegation: DelegationRow | null } {
    for (const address of user.addresses) {
      const delegation = this.delegations.findLatestByAddress(address);
      if (delegation) return { address, delegation };
    }
    const first = user.addresses[0];
    if (!first) throw new AppError(403, ErrorCode.FORBIDDEN, "Your sign-in holds no EVM wallet address");
    return { address: first, delegation: null };
  }

  private checkBounds(input: CreateGrantInput, now: number, payTokens: number): void {
    const issues: z.ZodIssue[] = [];
    const issue = (path: string, message: string) => issues.push({ code: z.ZodIssueCode.custom, path: [path], message });
    if (input.expiresAt <= now) issue("expiresAt", "must be in the future");
    else if (input.expiresAt > now + this.options.maxGrantMs) {
      issue("expiresAt", `must be at most ${Math.floor(this.options.maxGrantMs / 86_400_000)} days ahead`);
    }
    if (input.kind === "sell" && input.payMask !== undefined && input.payMask >= 1 << payTokens) {
      issue("payMask", `must select only the market's ${payTokens} pay tokens`);
    }
    if (input.kind === "bid" && input.payIdx >= payTokens) issue("payIdx", `must be below the market's ${payTokens} pay tokens`);
    if (issues.length > 0) throw new ZodError(issues);
  }
}
