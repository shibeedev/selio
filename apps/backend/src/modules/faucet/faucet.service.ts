import { randomUUID } from "node:crypto";
import { NETWORKS, type NetworkKey } from "@selio/sdk";
import type { Transactional } from "../../shared/db/database.js";
import { AppError } from "../../shared/errors/AppError.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { FaucetRepositoryPort } from "./faucet.repository.js";
import type { RequestKitInput } from "./faucet.schema.js";
import {
  FAUCET_IP_ADDRESSES,
  FAUCET_IP_BUDGET,
  FAUCET_IP_WINDOW_MS,
  FAUCET_LOCK_POLL_MS,
  FAUCET_LOCK_TTL_MS,
  FAUCET_LOCK_WAIT_MS,
  FAUCET_WINDOW_MS,
  type FaucetResult,
  type KitRunner,
} from "./faucet.types.js";

export interface FaucetServiceOptions {
  isFork: (network: NetworkKey) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newHolderId: () => string;
  windowMs: number;
  lockTtlMs: number;
  lockWaitMs: number;
  lockPollMs: number;
  ipWindowMs: number;
  ipBudget: number;
  ipAddresses: number;
}

/** A kit request plus the caller's IP bucket, for the per-IP budget. */
export type KitRequest = RequestKitInput & { ip: string };

function rateLimited(message: string, retryAfterSeconds: number): AppError {
  return new AppError(429, "FAUCET_RATE_LIMITED", `${message}; try again in ${retryAfterSeconds}s`, { retryAfterSeconds });
}

export class FaucetService {
  private readonly opts: FaucetServiceOptions;

  constructor(
    private readonly repo: FaucetRepositoryPort,
    private readonly kits: KitRunner,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    options: Partial<FaucetServiceOptions> = {},
  ) {
    this.opts = {
      isFork: (network) => NETWORKS[network].isFork,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      newHolderId: randomUUID,
      windowMs: FAUCET_WINDOW_MS,
      lockTtlMs: FAUCET_LOCK_TTL_MS,
      lockWaitMs: FAUCET_LOCK_WAIT_MS,
      lockPollMs: FAUCET_LOCK_POLL_MS,
      ipWindowMs: FAUCET_IP_WINDOW_MS,
      ipBudget: FAUCET_IP_BUDGET,
      ipAddresses: FAUCET_IP_ADDRESSES,
      ...options,
    };
  }

  async requestKit({ network, address, kit, ip }: KitRequest): Promise<FaucetResult> {
    if (!this.opts.isFork(network)) {
      throw new AppError(403, "FAUCET_FORK_ONLY", `The faucet only works on fork networks; ${network} is a live network`);
    }
    // Reserve the slot first so concurrent requests cannot both pass the rate limit.
    const grantId = this.reserve(network, address, kit, ip);
    const holder = this.opts.newHolderId();
    try {
      await this.acquireLock(network, holder);
      const actions = await this.kits.runKit(network, kit, address);
      this.logger.info({ network, kit }, "faucet kit delivered");
      return { ok: true, actions };
    } catch (err) {
      // A failed kit does not count against the rate limit.
      this.repo.deleteGrant(grantId);
      throw err;
    } finally {
      this.repo.releaseLock(network, holder);
    }
  }

  private reserve(network: NetworkKey, address: string, kit: string, ip: string): number {
    const { windowMs, ipWindowMs, ipBudget, ipAddresses } = this.opts;
    return this.inTransaction((tx) => {
      const now = this.opts.now();
      const last = this.repo.lastGrantAt(network, address, kit, tx);
      if (last !== null && now - last < windowMs) {
        throw rateLimited(
          `A ${kit} kit was already sent to this address on ${network}`,
          Math.ceil((last + windowMs - now) / 1000),
        );
      }
      // Older grants cannot limit anything any more, so they and their IP buckets are removed.
      this.repo.deleteGrantsBefore(now - Math.max(windowMs, ipWindowMs), tx);
      const since = now - ipWindowMs;
      const usage = this.repo.ipUsage(ip, since, tx);
      const retryAfter = Math.ceil(((usage.first ?? now) + ipWindowMs - now) / 1000);
      if (usage.grants >= ipBudget) {
        throw rateLimited("This network address has used its demo-funds budget", retryAfter);
      }
      if (usage.addresses >= ipAddresses && !this.repo.ipHasAddress(ip, address, since, tx)) {
        throw rateLimited("Too many different addresses from this network address", retryAfter);
      }
      return this.repo.insertGrant({ network, address, kit, at: now, ip }, tx);
    });
  }

  private async acquireLock(network: NetworkKey, holder: string): Promise<void> {
    const deadline = this.opts.now() + this.opts.lockWaitMs;
    for (;;) {
      if (this.repo.tryAcquireLock(network, holder, this.opts.now(), this.opts.lockTtlMs)) return;
      if (this.opts.now() >= deadline) {
        throw new AppError(503, "FAUCET_BUSY", "Another kit is being prepared on this fork; try again shortly");
      }
      await this.opts.sleep(this.opts.lockPollMs);
    }
  }
}
