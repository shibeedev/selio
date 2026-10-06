import { randomUUID } from "node:crypto";
import type { TokenInfo } from "@selio/sdk";
import {
  BaseError,
  formatUnits,
  getAddress,
  InsufficientFundsError,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import type { z } from "zod";
import { open } from "../../shared/crypto/seal.js";
import type { Transactional } from "../../shared/db/database.js";
import { AppError } from "../../shared/errors/AppError.js";
import { AGENT_CHAIN_ID, type BidState, type ChainPort, type ReceiptView } from "../../shared/integrations/chain/chain.gateway.js";
import {
  DelegationRejectedError,
  parseKeyShare,
  type DynamicPort,
  type ServerKeyShare,
} from "../../shared/integrations/dynamic/dynamic.gateway.js";
import { McpToolError, type McpPort } from "../../shared/integrations/mcp/mcp.client.js";
import { errorFields, type Logger } from "../../shared/middlewares/logger.js";
import type { DelegationPort } from "../delegations/index.js";
import type { GrantRepository, GrantRow } from "../grants/index.js";
import { checkAgentTx, committedAssets, SELECTORS, selectorOf, type AgentCall, type AgentTxContext, type Sized } from "../policy/policy.js";
import type { ActionRepository, ActionRow } from "./actions.repository.js";
import {
  MESSAGES,
  buildResult,
  exitCapacityResult,
  sellPlanResult,
  simulationResult,
  type AmountView,
  type BuildResult,
} from "./executor.types.js";
import type { IntentRepository } from "./intents.repository.js";

/** Ends an action early: "skipped" when there is nothing to do, "failed" when something refused or broke. */
class Stop extends Error {
  constructor(
    readonly status: "failed" | "skipped",
    message: string,
  ) {
    super(message);
    this.name = "Stop";
  }
}

const skip = (message: string) => new Stop("skipped", message);
const fail = (message: string) => new Stop("failed", message);
const min = (first: bigint, ...rest: bigint[]) => rest.reduce((a, b) => (b < a ? b : a), first);

export interface ExecutorOptions {
  /** Highest gas limit the agent signs (AGENT_MAX_GAS). */
  maxGas: bigint;
  intentTtlMs: number;
  storageKey: Buffer;
}

interface Materials {
  walletId: string;
  shareSetId?: string;
  keyShare: ServerKeyShare;
  walletApiKey: string;
}

interface Standing {
  id: bigint;
  state: BidState;
}

interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * Runs actions (F.5): one at a time per wallet, each sized from the grant and on-chain reads (E.1),
 * built through the MCP tools, checked against the policy (E.2), simulated, recorded as an intent
 * (E.3), signed through Dynamic delegated access, broadcast and confirmed.
 */
export class ExecutorService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  private lastPrune = 0;

  constructor(
    private readonly actions: ActionRepository,
    private readonly intents: IntentRepository,
    private readonly grants: GrantRepository,
    private readonly delegations: DelegationPort,
    private readonly chain: ChainPort,
    private readonly mcp: McpPort,
    private readonly dynamic: Pick<DynamicPort, "signTransaction"> | null,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    private readonly options: ExecutorOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs a planned action outside the request that created it. */
  enqueue(actionId: number): void {
    const task: Promise<void> = this.run(actionId)
      .catch((err: unknown) => {
        this.logger.error({ actionId, err: errorFields(err) }, "action crashed");
      })
      .finally(() => {
        this.running.delete(task);
      });
    this.running.add(task);
  }

  /** Resolves once every queued action has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  /** Waits for running actions up to `timeoutMs`; true when all of them finished. */
  async drain(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.idle().then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  lastActionId(): number {
    return this.actions.maxId();
  }

  async run(actionId: number): Promise<void> {
    const queued = this.actions.find(actionId);
    const owner = queued ? this.grants.find(queued.grantId) : null;
    if (!queued || !owner) return;
    await this.withLock(owner.address, async () => {
      const action = this.actions.find(actionId);
      if (!action || action.status !== "planned") return;
      try {
        await this.execute(action);
      } catch (err) {
        const { status, message } = outcomeOf(err);
        this.actions.finish(action.id, status, { message }, this.now());
        this.logger.info({ actionId: action.id, grantId: action.grantId, kind: action.kind, status, message }, `action ${status}`);
      }
    });
  }

  /**
   * F.8: actions interrupted by a restart. A sending action whose last transaction confirmed is
   * completed; any other planned or sending action up to `upToId` fails. No automatic retry.
   */
  async reconcile(upToId: number): Promise<void> {
    for (const row of this.actions.listUnfinished(upToId)) {
      const hash = row.txHashes.at(-1);
      if (row.status === "planned" || !hash) {
        this.actions.finish(row.id, "failed", { message: MESSAGES.interrupted }, this.now());
        continue;
      }
      let receipt: ReceiptView | null = null;
      try {
        receipt = await this.chain.findReceipt(hash);
      } catch (err) {
        this.logger.warn({ actionId: row.id, err: errorFields(err) }, "receipt lookup failed during reconciliation");
      }
      if (receipt?.status === "success") {
        const used = row.kind !== "cancel" && row.assets !== null ? BigInt(row.assets) : 0n;
        this.complete(row, used, {
          message: MESSAGES.completedAfterRestart,
          ...(receipt.placedBidId !== null ? { bidId: receipt.placedBidId.toString() } : {}),
        });
      } else {
        const message = receipt ? `Transaction ${hash} reverted` : MESSAGES.interrupted;
        this.actions.finish(row.id, "failed", { message }, this.now());
      }
    }
  }

  private async execute(action: ActionRow): Promise<void> {
    const grant = this.liveGrant(action);
    if (!this.dynamic) throw fail(MESSAGES.notConfigured);
    if (!this.hasAccess(grant.address)) throw skip(MESSAGES.noAccess);
    if (action.kind !== "cancel") {
      // The alert is only a trigger: act only if the chain still shows utilization at the threshold.
      const capacity = await this.tool("get_exit_capacity", { network: grant.network }, exitCapacityResult);
      if (capacity.utilization.bps < grant.thresholdBps) throw skip(MESSAGES.belowThreshold);
    }
    if (action.kind === "sell") await this.sell(action, grant);
    else if (action.kind === "bid") await this.bid(action, grant);
    else if (action.kind === "vault") await this.vault(action, grant);
    else await this.cancel(action, grant);
  }

  /** The grant as stored now: triggered actions need it active and unexpired; a cancel runs on a deleted grant. */
  private liveGrant(action: ActionRow): GrantRow {
    const grant = this.grants.find(action.grantId);
    if (!grant) throw fail(MESSAGES.grantInactive);
    if (action.kind === "cancel") return grant;
    const now = this.now();
    if (grant.status === "active" && now >= grant.expiresAt) this.grants.setStatus(grant.id, "expired", now);
    if (grant.status !== "active" || now >= grant.expiresAt) throw skip(MESSAGES.grantInactive);
    return grant;
  }

  private hasAccess(address: string): boolean {
    const row = this.delegations.findLatestByAddress(address);
    return row !== null && row.status === "active" && row.sealedShare !== null && row.sealedApiKey !== null;
  }

  /** E.1 sell: min(per-action max, budget left, receipt value), planned into bids within the sell limit. */
  private async sell(action: ActionRow, grant: GrantRow): Promise<void> {
    const d = this.chain.deployment();
    const wallet = getAddress(grant.address);
    const [underlying, payTokens, value] = await Promise.all([
      this.chain.token(d.underlying),
      this.chain.payTokens(),
      this.chain.receiptValueOf(wallet),
    ]);
    const assets = min(grant.maxPerAction, grant.maxTotal - grant.usedTotal, value);
    if (assets <= 0n) throw skip(MESSAGES.noReceipts);
    const args = {
      network: grant.network,
      assets: formatUnits(assets, underlying.decimals),
      maxDiscountBps: grant.maxSellDiscountBps ?? 0,
      payTokens: payTokens.filter((_, i) => ((grant.payMask ?? 0) >> i) & 1).map((t) => t.address),
    };
    const plan = await this.tool("plan_sell_now", args, sellPlanResult);
    const filled = BigInt(plan.filled.raw);
    if (filled === 0n) throw skip(MESSAGES.noBid);
    const [shares, allowance] = await Promise.all([
      this.chain.receiptAmountFor(filled),
      this.chain.allowance(d.receipt, wallet, d.market),
    ]);
    // One share unit of slack per fill, as the Morpho build allows.
    if (shares + BigInt(plan.fills.length) > allowance) throw skip(MESSAGES.allowanceTooSmall);
    const build = await this.tool(
      "build_sell_now",
      { ...args, from: wallet, minFilled: formatUnits(filled, underlying.decimals) },
      buildResult,
    );
    const commit = {
      fee: inUnderlying(build.details?.fees, payTokens, underlying.decimals),
      net: inUnderlying(build.details?.sellerNet, payTokens, underlying.decimals),
    };
    const { call } = await this.send(action, grant, build, { assets }, null, commit);
    this.complete(action, committedAssets(call), {});
  }

  /** E.1 bid: cancel the grant's standing bid (crediting its remaining maximum), then place one sized bid. */
  private async bid(action: ActionRow, grant: GrantRow): Promise<void> {
    const d = this.chain.deployment();
    const wallet = getAddress(grant.address);
    const [underlying, payTokens] = await Promise.all([this.chain.token(d.underlying), this.chain.payTokens()]);
    const pay = payTokens[grant.payIdx ?? -1];
    if (!pay) throw fail("The grant's pay token is not on this market");
    const standing = await this.standingBid(grant, wallet);
    let current = grant;
    let sized: { maxAssets: bigint; escrow: bigint };
    if (!standing) {
      sized = await this.sizeBid(grant, pay, wallet, null);
    } else {
      // Sized first with the escrow the cancel refunds, so a new bid that would be too small cancels nothing.
      await this.sizeBid(grant, pay, wallet, standing);
      const cancel = await this.tool(
        "build_cancel_bid",
        { network: grant.network, bidId: standing.id.toString(), from: wallet },
        buildResult,
      );
      await this.send(action, grant, cancel, {}, standing.id, null);
      this.grants.addUsed(grant.id, -standing.state.maxAssets, this.now());
      try {
        current = this.liveGrant(action);
        sized = await this.sizeBid(current, pay, wallet, null);
      } catch (err) {
        if (!(err instanceof Stop) || err.status !== "skipped") throw err;
        this.complete(action, 0n, { message: `Cancelled the standing bid; no new bid: ${err.message}` });
        return;
      }
    }
    const place = await this.tool(
      "build_place_bid",
      {
        network: current.network,
        from: wallet,
        minDiscountBps: current.minBidDiscountBps ?? 0,
        payToken: pay.address,
        maxAssets: formatUnits(sized.maxAssets, underlying.decimals),
        escrow: formatUnits(sized.escrow, pay.decimals),
      },
      buildResult,
    );
    const { call, receipt } = await this.send(action, current, place, sized, null, {});
    this.complete(action, committedAssets(call), { bidId: receipt.placedBidId?.toString() ?? null });
  }

  /** E.1 vault: min(per-action max, budget left, wallet balance, allowance to the Selio Vault). */
  private async vault(action: ActionRow, grant: GrantRow): Promise<void> {
    const d = this.chain.deployment();
    const wallet = getAddress(grant.address);
    const [underlying, balance, allowance] = await Promise.all([
      this.chain.token(d.underlying),
      this.chain.balanceOf(d.underlying, wallet),
      this.chain.allowance(d.underlying, wallet, d.selioVault),
    ]);
    const assets = min(grant.maxPerAction, grant.maxTotal - grant.usedTotal, balance, allowance);
    if (assets <= 0n) throw skip(MESSAGES.nothingToDeposit);
    const build = await this.tool(
      "build_vault_deposit",
      { network: grant.network, from: wallet, receiver: wallet, assets: formatUnits(assets, underlying.decimals) },
      buildResult,
    );
    const { call } = await this.send(action, grant, build, { assets }, null, {});
    this.complete(action, committedAssets(call), {});
  }

  /** After a grant is deleted with cancelBid: cancel its standing bid so the escrow returns to the user. */
  private async cancel(action: ActionRow, grant: GrantRow): Promise<void> {
    const wallet = getAddress(grant.address);
    const standing = await this.standingBid(grant, wallet);
    if (!standing) throw skip(MESSAGES.noStandingBid);
    const build = await this.tool(
      "build_cancel_bid",
      { network: grant.network, bidId: standing.id.toString(), from: wallet },
      buildResult,
    );
    await this.send(action, grant, build, {}, standing.id, null);
    this.complete(action, -standing.state.maxAssets, { bidId: standing.id.toString() });
  }

  /** The bid of the grant's latest done bid action, while it is still live and the wallet's. */
  private async standingBid(grant: GrantRow, wallet: Address): Promise<Standing | null> {
    const id = this.actions.latestDoneBidId(grant.id);
    if (id === null) return null;
    const state = await this.chain.bid(id);
    return isAddressEqual(state.bidder, wallet) ? { id, state } : null;
  }

  private async sizeBid(
    grant: GrantRow,
    pay: TokenInfo,
    wallet: Address,
    standing: Standing | null,
  ): Promise<{ maxAssets: bigint; escrow: bigint }> {
    const market = this.chain.deployment().market;
    const discount = grant.minBidDiscountBps ?? 0;
    let maxAssets = min(grant.maxPerAction, grant.maxTotal - grant.usedTotal + (standing?.state.maxAssets ?? 0n));
    if (maxAssets <= 0n) throw skip(MESSAGES.budgetUsed);
    const [balance, allowance] = await Promise.all([
      this.chain.balanceOf(pay.address, wallet),
      this.chain.allowance(pay.address, wallet, market),
    ]);
    const available = min(balance + (standing?.state.escrow ?? 0n), allowance);
    let escrow = await this.chain.quote(maxAssets, discount, pay.address);
    if (escrow > available) {
      maxAssets = (maxAssets * available) / escrow;
      if (maxAssets === 0n) throw skip(MESSAGES.bidTooSmall);
      escrow = await this.chain.quote(maxAssets, discount, pay.address);
    }
    // The contract refuses bids below the minimum escrow or with no capacity at their own discount (S7).
    const [minEscrow, capacity] = await Promise.all([
      this.chain.minEscrowOf(pay.address),
      this.chain.assetsFor(escrow, discount, pay.address),
    ]);
    if (escrow < minEscrow || min(capacity, maxAssets) === 0n) throw skip(MESSAGES.bidTooSmall);
    return { maxAssets, escrow };
  }

  /**
   * Checks every transaction of a build (E.2) before signing any, then simulates, signs, broadcasts
   * and confirms each in order. With `commit`, the last transaction commits the grant's budget.
   */
  private async send(
    action: ActionRow,
    grant: GrantRow,
    build: BuildResult,
    sized: Sized,
    standingBidId: bigint | null,
    commit: { fee?: string | null; net?: string | null } | null,
  ): Promise<{ call: AgentCall; receipt: ReceiptView }> {
    const txs: TxRequest[] = build.transactions.map((t) => ({ to: getAddress(t.to), data: t.data as Hex, value: BigInt(t.value) }));
    if (txs.length === 0) throw fail("The MCP build returned no transaction");
    if (txs.some((t) => selectorOf(t.data) === SELECTORS.approve)) throw fail(MESSAGES.noApprovals);
    const ctx: AgentTxContext = {
      action: action.kind,
      grant,
      deployment: this.chain.deployment(),
      wallet: getAddress(grant.address),
      chainId: await this.chain.chainId(),
      now: this.now(),
      sized,
      standingBidId,
    };
    const calls = txs.map((tx) => {
      const result = checkAgentTx(tx, ctx);
      if (!result.ok) throw fail(result.reason);
      return result.call;
    });
    let last: { call: AgentCall; receipt: ReceiptView } | undefined;
    for (const [i, tx] of txs.entries()) {
      const call = calls[i]!;
      const fields = commit && i === txs.length - 1 ? { assets: committedAssets(call).toString(), ...commit } : {};
      last = { call, receipt: await this.sendOne(action, grant, tx, fields) };
    }
    return last!;
  }

  private async sendOne(
    action: ActionRow,
    grant: GrantRow,
    tx: TxRequest,
    fields: { assets?: string; fee?: string | null; net?: string | null },
  ): Promise<ReceiptView> {
    const wallet = getAddress(grant.address);
    const simulation = await this.tool(
      "simulate_transaction",
      { network: grant.network, from: wallet, to: tx.to, data: tx.data, value: tx.value.toString() },
      simulationResult,
    );
    if (!simulation.ok) {
      throw fail(`The simulation failed (${simulation.revert?.name ?? simulation.message ?? "reverted"}); nothing was signed`);
    }
    const prepared = await this.fundsCheck(() => this.chain.prepare({ from: wallet, to: tx.to, data: tx.data }));
    if (prepared.gas > this.options.maxGas) {
      throw fail(`The transaction needs ${prepared.gas} gas, above the agent's limit of ${this.options.maxGas}`);
    }
    if ((await this.chain.nativeBalance(wallet)) < prepared.gas * prepared.maxFeePerGas) throw fail(MESSAGES.monForGas);
    const materials = this.materials(grant.address);
    this.recordIntent(materials.walletId, tx, prepared.nonce);
    const signed = await this.sign(materials, {
      type: "eip1559",
      chainId: AGENT_CHAIN_ID,
      to: tx.to,
      data: tx.data,
      value: 0n,
      nonce: prepared.nonce,
      gas: prepared.gas,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
    });
    // Recorded before the broadcast, so a restart can look the transaction up (F.8).
    const hash = keccak256(signed);
    this.actions.appendHash(action.id, hash, fields, this.now());
    await this.fundsCheck(() => this.chain.sendRawTransaction(signed));
    const receipt = await this.chain.waitForReceipt(hash);
    if (receipt.status !== "success") throw fail(`Transaction ${hash} reverted`);
    return receipt;
  }

  /** Opens the sealed materials for one signing call; they are never kept. */
  private materials(address: string): Materials {
    const row = this.delegations.findLatestByAddress(address);
    if (!row || row.status !== "active" || !row.sealedShare || !row.sealedApiKey) throw fail(MESSAGES.noAccess);
    const key = this.options.storageKey;
    return {
      walletId: row.walletId,
      ...(row.shareSetId ? { shareSetId: row.shareSetId } : {}),
      keyShare: parseKeyShare(open(row.sealedShare, key, row.walletId)),
      walletApiKey: open(row.sealedApiKey, key, row.walletId),
    };
  }

  private async sign(materials: Materials, transaction: TransactionSerializableEIP1559): Promise<Hex> {
    if (!this.dynamic) throw fail(MESSAGES.notConfigured);
    try {
      return await this.dynamic.signTransaction({ ...materials, transaction });
    } catch (err) {
      if (err instanceof DelegationRejectedError) {
        this.delegations.end(materials.walletId, "invalid");
        throw fail(MESSAGES.rejected);
      }
      throw err;
    }
  }

  private recordIntent(walletId: string, tx: TxRequest, nonce: number): void {
    const now = this.now();
    if (now - this.lastPrune >= this.options.intentTtlMs) {
      this.intents.pruneExpired(now);
      this.lastPrune = now;
    }
    this.intents.insert({
      id: randomUUID(),
      walletId,
      chainId: AGENT_CHAIN_ID,
      to: tx.to,
      dataHash: keccak256(tx.data),
      nonce,
      expiresAt: now + this.options.intentTtlMs,
    });
  }

  private async fundsCheck<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BaseError && err.walk((e) => e instanceof InsufficientFundsError)) throw fail(MESSAGES.monForGas);
      throw err;
    }
  }

  private complete(action: ActionRow, usedDelta: bigint, fields: { bidId?: string | null; message?: string | null }): void {
    const now = this.now();
    this.inTransaction((tx) => {
      if (usedDelta !== 0n) this.grants.addUsed(action.grantId, usedDelta, now, tx);
      this.actions.finish(action.id, "done", fields, now, tx);
    });
    this.logger.info({ actionId: action.id, grantId: action.grantId, kind: action.kind }, "action done");
  }

  private async tool<S extends z.ZodTypeAny>(name: string, args: Record<string, unknown>, schema: S): Promise<z.infer<S>> {
    const parsed = schema.safeParse(await this.mcp.callTool(name, args));
    if (!parsed.success) throw fail(`Unexpected answer from the MCP tool ${name}`);
    return parsed.data as z.infer<S>;
  }

  private withLock(key: string, fn: () => Promise<void>): Promise<void> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}

function outcomeOf(err: unknown): { status: "failed" | "skipped"; message: string } {
  if (err instanceof Stop) return { status: err.status, message: err.message };
  if (err instanceof McpToolError || err instanceof AppError) return { status: "failed", message: err.message };
  if (err instanceof BaseError) return { status: "failed", message: `Chain request failed: ${err.shortMessage}` };
  return { status: "failed", message: err instanceof Error ? err.message : String(err) };
}

/**
 * Sum of pay-token amounts in underlying base units. On monad-testnet every pay token is priced at a
 * fixed $1 (Part 0 §0.7), so an amount converts by its decimals alone.
 */
function inUnderlying(views: AmountView[] | undefined, payTokens: TokenInfo[], decimals: number): string | null {
  if (!views) return null;
  let total = 0n;
  for (const view of views) {
    const token = payTokens.find((t) => t.symbol === view.symbol);
    if (!token) return null;
    const raw = BigInt(view.raw);
    total +=
      token.decimals >= decimals ? raw / 10n ** BigInt(token.decimals - decimals) : raw * 10n ** BigInt(decimals - token.decimals);
  }
  return total.toString();
}
