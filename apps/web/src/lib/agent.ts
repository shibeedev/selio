import { useMemo } from "react";
import type { Address } from "viem";
import type { WalletAccount } from "@dynamic-labs-sdk/client";
import { alertSession } from "./alerts";
import {
  AgentApiError,
  createAgentApi,
  SIGN_IN_AGAIN,
  type AgentApi,
  type CreateGrantBody,
  type GrantDto,
  type GrantKind,
  type MeDto,
} from "./agent-api";
import { deleteAlert } from "./api";
import { agentBaseUrl, dynamicEnvironmentId } from "./env";
import { formatBps, parseAmountInput, parsePercentToBps } from "./format";
import { useAsync, type AsyncState } from "./hooks";
import { useNetwork } from "./network-context";
import { loadDynamic, useWallet } from "./wallet-context";

/** Longest grant lifetime the agent accepts (its MAX_GRANT_MS default). */
export const MAX_GRANT_DAYS = 30;
/** The market's MAX_DISCOUNT_BPS, which bounds both discount limits of a grant. */
export const MAX_GRANT_DISCOUNT_BPS = 5_000;
/** How often and how long the panel waits for Dynamic's delegation webhook to reach the agent. */
export const DELEGATION_POLL_MS = 2_000;
export const DELEGATION_WAIT_MS = 60_000;
/**
 * A sell-now fill on Morpho moves the shares for its face value rounded up, and the agent asks for one
 * spare share unit per fill; the sell approval covers that for up to 100 fills over the grant's life.
 */
export const SELL_APPROVAL_SLACK_UNITS = 100n;

export const KIND_LABEL: Record<GrantKind, string> = {
  sell: "Sell early into bids",
  bid: "Keep a limit bid",
  vault: "Add to the Selio Vault",
};

export interface GrantForm {
  kind: GrantKind;
  /** Utilization threshold, percent. */
  threshold: string;
  /** Amounts in the underlying, decimal text. */
  maxPerAction: string;
  maxTotal: string;
  /** Last day of the grant, `YYYY-MM-DD` in local time; the grant ends at the end of that day. */
  expires: string;
  /** sell: highest discount accepted, percent. */
  sellDiscount: string;
  /** sell: pay tokens accepted. */
  payMask: number;
  /** bid: lowest discount, percent. */
  bidDiscount: string;
  /** bid: pay token index. */
  payIdx: number;
}

export type GrantField = Exclude<keyof GrantForm, "kind">;
export type GrantErrors = Partial<Record<GrantField, string>>;

export interface GrantDraft {
  kind: GrantKind;
  thresholdBps: number;
  maxPerAction: bigint;
  maxTotal: bigint;
  expiresAt: number;
  maxSellDiscountBps: number | null;
  payMask: number | null;
  minBidDiscountBps: number | null;
  payIdx: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date `days` after `now`, as `YYYY-MM-DD`. */
export function localDate(now: number, days = 0): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** End of a local `YYYY-MM-DD` day in ms, or null for anything else. */
export function endOfLocalDay(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const end = new Date(y, mo - 1, d, 23, 59, 59, 999);
  return end.getMonth() === mo - 1 && end.getDate() === d ? end.getTime() : null;
}

/**
 * The dates a grant may end on: today up to the last day whose end is within MAX_GRANT_DAYS of now (the
 * end of day 30 would be past that bound, so the last day is 29 days ahead).
 */
export function expiryBounds(now: number): { min: string; max: string } {
  return { min: localDate(now), max: localDate(now, MAX_GRANT_DAYS - 1) };
}

export function defaultGrantForm(now: number, payTokenCount: number): GrantForm {
  return {
    kind: "sell",
    threshold: "95",
    maxPerAction: "100",
    maxTotal: "500",
    expires: localDate(now, 7),
    sellDiscount: "5",
    payMask: (1 << payTokenCount) - 1,
    bidDiscount: "3",
    payIdx: 0,
  };
}

function discountError(bps: number | null): string | null {
  return bps === null || bps > MAX_GRANT_DISCOUNT_BPS ? `Enter a discount from 0 to ${formatBps(MAX_GRANT_DISCOUNT_BPS, 0)}` : null;
}

/** Checks the form with the agent's rules (createGrantSchema and its bounds) before anything is signed. */
export function parseGrantForm(
  form: GrantForm,
  ctx: { decimals: number; payTokenCount: number; now: number },
): { draft: GrantDraft | null; errors: GrantErrors } {
  const errors: GrantErrors = {};
  const thresholdBps = parsePercentToBps(form.threshold);
  if (thresholdBps === null || thresholdBps < 1 || thresholdBps > 10_000) {
    errors.threshold = "Enter a utilization between 0.01 and 100";
  }
  const perAction = parseAmountInput(form.maxPerAction, ctx.decimals);
  if (perAction.error) errors.maxPerAction = perAction.error;
  else if (perAction.value === null || perAction.value <= 0n) errors.maxPerAction = "Enter an amount above 0";
  const total = parseAmountInput(form.maxTotal, ctx.decimals);
  if (total.error) errors.maxTotal = total.error;
  else if (total.value === null || total.value <= 0n) errors.maxTotal = "Enter an amount above 0";
  else if (perAction.value !== null && total.value < perAction.value) {
    errors.maxTotal = "The total budget must be at least the per-action maximum";
  }
  const expiresAt = endOfLocalDay(form.expires);
  const { max } = expiryBounds(ctx.now);
  if (expiresAt === null || expiresAt <= ctx.now || expiresAt > ctx.now + MAX_GRANT_DAYS * 86_400_000) {
    errors.expires = `Pick a day from today to ${max}`;
  }
  const allMask = (1 << ctx.payTokenCount) - 1;
  let maxSellDiscountBps: number | null = null;
  let payMask: number | null = null;
  let minBidDiscountBps: number | null = null;
  let payIdx: number | null = null;
  if (form.kind === "sell") {
    maxSellDiscountBps = parsePercentToBps(form.sellDiscount);
    const e = discountError(maxSellDiscountBps);
    if (e) errors.sellDiscount = e;
    payMask = form.payMask;
    if (!Number.isInteger(payMask) || payMask < 1 || payMask > allMask) errors.payMask = "Pick at least one pay token";
  } else if (form.kind === "bid") {
    minBidDiscountBps = parsePercentToBps(form.bidDiscount);
    const e = discountError(minBidDiscountBps);
    if (e) errors.bidDiscount = e;
    payIdx = form.payIdx;
    if (!Number.isInteger(payIdx) || payIdx < 0 || payIdx >= ctx.payTokenCount) errors.payIdx = "Pick a pay token";
  }
  if (Object.keys(errors).length > 0) return { draft: null, errors };
  return {
    draft: {
      kind: form.kind,
      thresholdBps: thresholdBps as number,
      maxPerAction: perAction.value as bigint,
      maxTotal: total.value as bigint,
      expiresAt: expiresAt as number,
      maxSellDiscountBps,
      payMask,
      minBidDiscountBps,
      payIdx,
    },
    errors,
  };
}

/** The alert webhook that triggers the grant; the backend posts each crossing of its threshold here. */
export function hookUrl(agentUrl: string, grantId: string): string {
  return `${agentUrl.replace(/\/+$/, "")}/hooks/alert/${encodeURIComponent(grantId)}`;
}

/** POST /agent/v1/grants for a checked draft, with only the fields of its kind. */
export function grantBody(draft: GrantDraft, ids: { id: string; alertId: string }): CreateGrantBody {
  const base = {
    id: ids.id,
    network: "monad-testnet" as const,
    alertId: ids.alertId,
    thresholdBps: draft.thresholdBps,
    maxPerAction: draft.maxPerAction.toString(),
    maxTotal: draft.maxTotal.toString(),
    expiresAt: draft.expiresAt,
  };
  if (draft.kind === "sell") {
    return { ...base, kind: "sell", maxSellDiscountBps: draft.maxSellDiscountBps ?? 0, payMask: draft.payMask ?? undefined };
  }
  if (draft.kind === "bid") return { ...base, kind: "bid", minBidDiscountBps: draft.minBidDiscountBps ?? 0, payIdx: draft.payIdx ?? 0 };
  return { ...base, kind: "vault" };
}

export interface GrantApproval {
  token: Address;
  spender: Address;
  amount: bigint;
}

/**
 * The exact approval a grant needs, which the user signs: it is the on-chain ceiling of what the agent can
 * spend, since the agent never signs an approval. Sell: receipts to the market; bid: the pay token to the
 * market, at the bid's price for the whole budget; vault: the underlying to the Selio Vault.
 */
export async function grantApproval(
  draft: Pick<GrantDraft, "kind" | "maxTotal" | "minBidDiscountBps" | "payIdx">,
  targets: { market: Address; selioVault: Address; receipt: Address; underlying: Address; payTokens: readonly Address[] },
  reader: {
    receiptAmountFor(assets: bigint): Promise<bigint>;
    quote(assets: bigint, discountBps: number, payToken: Address): Promise<bigint>;
  },
): Promise<GrantApproval> {
  if (draft.kind === "sell") {
    const shares = await reader.receiptAmountFor(draft.maxTotal);
    return { token: targets.receipt, spender: targets.market, amount: shares + SELL_APPROVAL_SLACK_UNITS };
  }
  if (draft.kind === "bid") {
    const payToken = targets.payTokens[draft.payIdx ?? -1];
    if (!payToken) throw new Error("Pick a pay token for the bid.");
    const amount = await reader.quote(draft.maxTotal, draft.minBidDiscountBps ?? 0, payToken);
    return { token: payToken, spender: targets.market, amount };
  }
  return { token: targets.underlying, spender: targets.selioVault, amount: draft.maxTotal };
}

/**
 * Revoking the agent: the agent service first (it deletes the delegated materials and every grant before it
 * answers), then Dynamic's reshare, which invalidates the agent's key share, then the grants' alerts. A failed
 * reshare is ignored when the agent's admin call already revoked the delegation on Dynamic's side.
 */
export async function revokeAgent(steps: {
  revoke(): Promise<{ dynamicRevoked: boolean }>;
  reshare(): Promise<void>;
  deleteAlerts(): Promise<void>;
}): Promise<{ dynamicRevoked: boolean; warning: string | null }> {
  const { dynamicRevoked } = await steps.revoke();
  let warning: string | null = null;
  try {
    await steps.reshare();
  } catch (e) {
    if (!dynamicRevoked) {
      const reason = e instanceof Error ? e.message : String(e);
      warning = `The agent has stopped, but Dynamic has not confirmed the revocation yet (${reason}). Revoke again later to finish it.`;
    }
  }
  await steps.deleteAlerts().catch(() => undefined);
  return { dynamicRevoked, warning };
}

/** The exit agent needs both a Dynamic environment and the agent service in this build. */
export function agentConfigured(): boolean {
  return dynamicEnvironmentId() !== null && agentBaseUrl() !== null;
}

/** The Dynamic JWT every agent call carries; a missing one means the user has to sign in again. */
export async function agentToken(): Promise<string> {
  const token = (await loadDynamic()).jwt();
  if (!token) throw new AgentApiError(SIGN_IN_AGAIN, "UNAUTHORIZED", 401);
  return token;
}

/** The agent's view of the connected email or passkey wallet: delegation, grants and recent actions. */
export function useAgentMe(opts: { enabled: boolean; pollMs?: number }): AsyncState<MeDto> & { api: AgentApi | null } {
  const { refreshKey } = useNetwork();
  const { address } = useWallet();
  const url = agentBaseUrl();
  const api = useMemo(() => (url ? createAgentApi(url) : null), [url]);
  const enabled = opts.enabled && api !== null && address !== null;
  const me = useAsync(async () => (api as AgentApi).me(await agentToken()), [api, address], {
    enabled,
    pollMs: opts.pollMs,
    reloadKey: refreshKey,
  });
  return { ...me, api };
}

/** Revokes the agent for the connected wallet (see revokeAgent), deleting its grants' alerts when signed in. */
export async function revokeAgentFor(p: {
  api: AgentApi;
  account: WalletAccount;
  owner: Address;
  grants: readonly GrantDto[];
}): Promise<{ dynamicRevoked: boolean; warning: string | null }> {
  const d = await loadDynamic();
  return revokeAgent({
    revoke: async () => p.api.revoke(await agentToken()),
    reshare: async () => {
      if (d.hasDelegation(p.account)) await d.revokeDelegation(p.account);
    },
    deleteAlerts: async () => {
      const session = alertSession(p.owner);
      if (!session) return;
      await Promise.all(p.grants.map((g) => deleteAlert(g.alertId, p.owner, session.token).catch(() => undefined)));
    },
  });
}
