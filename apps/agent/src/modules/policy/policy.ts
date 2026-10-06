import { aaveExitMarketAbi, selioVaultAbi, type Deployment } from "@selio/sdk";
import { decodeFunctionData, isHex, keccak256, type Address, type Hex } from "viem";
import { AGENT_CHAIN_ID, AGENT_NETWORK } from "../../shared/integrations/chain/chain.gateway.js";

/** The only calls the agent signs (Part 2 selector list), and the ERC-20 approval it never signs. */
export const SELECTORS = {
  sellNow: "0x29cc1ca0", // sellNow(uint256,uint256[],uint16,uint8,uint256) on the exit market
  placeBid: "0x04978e30", // placeBid(uint16,uint8,uint256,uint256) on the exit market
  cancelBid: "0x9703ef35", // cancelBid(uint256) on the exit market
  deposit: "0xbc157ac1", // deposit(uint256,address,uint256) on the Selio Vault
  approve: "0x095ea7b3", // approve(address,uint256) on a token
} as const;

/** Fixed Transaction Review deny reasons; never echoes of request fields. */
export const DENY = {
  policy: "Not allowed by Selio policy",
  intent: "No matching agent intent",
  chain: "Selio wallets sign only on Monad testnet",
} as const;

export interface PolicyGrant {
  kind: "sell" | "bid" | "vault";
  status: string;
  network: string;
  expiresAt: number;
  maxPerAction: bigint;
  maxSellDiscountBps: number | null;
  payMask: number | null;
  minBidDiscountBps: number | null;
  payIdx: number | null;
}

/** The sizes the executor computed for this action (E.1). */
export interface Sized {
  assets?: bigint;
  maxAssets?: bigint;
  escrow?: bigint;
}

export interface AgentTxContext {
  /** "cancel" is the clean-up of a deleted grant: only its standing bid may be cancelled. */
  action: "sell" | "bid" | "vault" | "cancel";
  grant: PolicyGrant;
  deployment: Pick<Deployment, "network" | "chainId" | "market" | "selioVault">;
  wallet: Address;
  chainId: number;
  now: number;
  sized: Sized;
  standingBidId: bigint | null;
}

export type AgentCall =
  | { fn: "sellNow"; assets: bigint; bidIds: readonly bigint[]; maxDiscountBps: number; payMask: number; minFilled: bigint }
  | { fn: "placeBid"; minDiscountBps: number; payIdx: number; maxAssets: bigint; escrow: bigint }
  | { fn: "cancelBid"; bidId: bigint }
  | { fn: "deposit"; assets: bigint; receiver: Address; minShares: bigint };

export type PolicyResult = { ok: true; call: AgentCall } | { ok: false; reason: string };

export const selectorOf = (data: string) => (data.length >= 10 ? data.slice(0, 10).toLowerCase() : "");

const refuse = (reason: string): PolicyResult => ({ ok: false, reason });
const within = (value: bigint, sized: bigint | undefined, max: bigint) => sized !== undefined && value <= sized && value <= max;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * E.2: run on every transaction of a built action before anything is signed. Only the four Selio
 * calls pass, each within the grant's limits and the sizes the executor computed.
 */
export function checkAgentTx(tx: { to: Address; data: Hex; value: bigint }, ctx: AgentTxContext): PolicyResult {
  const { grant, deployment } = ctx;
  if (ctx.action !== "cancel" && !(grant.status === "active" && ctx.now < grant.expiresAt)) {
    return refuse("The grant is not active");
  }
  if (grant.network !== AGENT_NETWORK || ctx.chainId !== AGENT_CHAIN_ID) return refuse("The agent acts only on Monad testnet");
  if (deployment.network !== AGENT_NETWORK || deployment.chainId !== AGENT_CHAIN_ID) {
    return refuse("The deployment is not the Monad testnet one");
  }
  if (tx.value !== 0n) return refuse("The transaction sends native value");
  const selector = selectorOf(tx.data);

  if (same(tx.to, deployment.market)) {
    const decoded = decode(() => decodeFunctionData({ abi: aaveExitMarketAbi, data: tx.data }));
    if (selector === SELECTORS.sellNow && decoded?.functionName === "sellNow") {
      const [assets, bidIds, maxDiscountBps, payMask, minFilled] = decoded.args as readonly [
        bigint,
        readonly bigint[],
        number,
        number,
        bigint,
      ];
      if (grant.kind !== "sell" || ctx.action !== "sell") return refuse("This grant may not sell");
      if (!within(assets, ctx.sized.assets, grant.maxPerAction)) return refuse("The sale is larger than the agent sized it");
      if (grant.maxSellDiscountBps === null || maxDiscountBps > grant.maxSellDiscountBps) {
        return refuse("The sale's discount is above your sell limit");
      }
      if (payMask === 0 || grant.payMask === null || (payMask & ~grant.payMask) !== 0) {
        return refuse("The sale accepts a pay token outside your grant");
      }
      if (minFilled <= 0n || minFilled > assets) return refuse("The sale has no valid minimum fill");
      return { ok: true, call: { fn: "sellNow", assets, bidIds, maxDiscountBps, payMask, minFilled } };
    }
    if (selector === SELECTORS.placeBid && decoded?.functionName === "placeBid") {
      const [minDiscountBps, payIdx, maxAssets, escrow] = decoded.args as readonly [number, number, bigint, bigint];
      if (grant.kind !== "bid" || ctx.action !== "bid") return refuse("This grant may not place bids");
      if (grant.minBidDiscountBps === null || minDiscountBps < grant.minBidDiscountBps) {
        return refuse("The bid's discount is below your bid limit");
      }
      if (payIdx !== grant.payIdx) return refuse("The bid pays in a token outside your grant");
      if (!within(maxAssets, ctx.sized.maxAssets, grant.maxPerAction)) return refuse("The bid is larger than the agent sized it");
      if (ctx.sized.escrow === undefined || escrow > ctx.sized.escrow) return refuse("The bid escrows more than the agent sized it");
      return { ok: true, call: { fn: "placeBid", minDiscountBps, payIdx, maxAssets, escrow } };
    }
    if (selector === SELECTORS.cancelBid && decoded?.functionName === "cancelBid") {
      const [bidId] = decoded.args as readonly [bigint];
      if (grant.kind !== "bid") return refuse("This grant has no bids");
      if (ctx.standingBidId === null || bidId !== ctx.standingBidId) return refuse("The bid is not this grant's standing bid");
      return { ok: true, call: { fn: "cancelBid", bidId } };
    }
  }

  if (same(tx.to, deployment.selioVault) && selector === SELECTORS.deposit) {
    const decoded = decode(() => decodeFunctionData({ abi: selioVaultAbi, data: tx.data }));
    if (decoded?.functionName === "deposit") {
      const [assets, receiver, minShares] = decoded.args as readonly [bigint, Address, bigint];
      if (grant.kind !== "vault" || ctx.action !== "vault") return refuse("This grant may not deposit");
      if (!same(receiver, ctx.wallet)) return refuse("The deposit names another receiver");
      if (!within(assets, ctx.sized.assets, grant.maxPerAction)) return refuse("The deposit is larger than the agent sized it");
      if (minShares <= 0n) return refuse("The deposit has no minimum of shares");
      return { ok: true, call: { fn: "deposit", assets, receiver, minShares } };
    }
  }

  return refuse("Not a Selio action the agent may sign");
}

function decode<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** The committed face value of a call, the amount counted against the grant's budget. */
export function committedAssets(call: AgentCall): bigint {
  if (call.fn === "sellNow" || call.fn === "deposit") return call.assets;
  if (call.fn === "placeBid") return call.maxAssets;
  return 0n;
}

/** The request Dynamic sends to Transaction Review; only the fields the check reads. */
export interface ReviewRequest {
  walletId?: unknown;
  shareSetType?: unknown;
  context?: unknown;
}

export type ReviewCheck =
  | { verdict: "proceed" }
  | { verdict: "deny"; reason: string }
  /** A delegated transaction passed the static checks; it proceeds only with a matching intent. */
  | { verdict: "intent"; walletId: string; to: string; nonce: number; dataHash: Hex };

const OTHER_PAYLOADS = ["evmTypedData", "evmMessage", "evmUserOperation", "rawSign"];

/**
 * E.3, statically (no chain read): delegated signatures are only the four Selio calls on Monad
 * testnet with value 0, and still need an intent; the user's own wallet signs transactions and typed
 * data on Monad testnet only, and messages everywhere; everything else is denied.
 */
export function checkReviewRequest(req: ReviewRequest, deployment: Pick<Deployment, "market" | "selioVault"> | null): ReviewCheck {
  const deny = (reason: string): ReviewCheck => ({ verdict: "deny", reason });
  const context = asRecord(req.context) ?? {};
  const tx = asRecord(context.evmTransaction);
  switch (req.shareSetType) {
    case "delegated": {
      if (!tx || OTHER_PAYLOADS.some((key) => context[key] !== undefined && context[key] !== null)) return deny(DENY.policy);
      if (toInteger(tx.chainId) !== AGENT_CHAIN_ID) return deny(DENY.chain);
      if (toInteger(tx.value ?? 0) !== 0) return deny(DENY.policy);
      const to = typeof tx.to === "string" ? tx.to.toLowerCase() : "";
      const data = typeof tx.data === "string" && isHex(tx.data) ? tx.data : null;
      if (!deployment || !data || !isAllowedPair(to, selectorOf(data), deployment)) return deny(DENY.policy);
      const nonce = toInteger(tx.nonce);
      if (nonce === null || typeof req.walletId !== "string") return deny(DENY.intent);
      return { verdict: "intent", walletId: req.walletId, to, nonce, dataHash: keccak256(data) };
    }
    case "rootUser": {
      if (tx) return toInteger(tx.chainId) === AGENT_CHAIN_ID ? { verdict: "proceed" } : deny(DENY.chain);
      const typedData = asRecord(context.evmTypedData);
      if (typedData) {
        const domain = asRecord(typedData.domain);
        return domain && toInteger(domain.chainId) === AGENT_CHAIN_ID ? { verdict: "proceed" } : deny(DENY.chain);
      }
      if (context.evmMessage !== undefined && context.evmMessage !== null) return { verdict: "proceed" };
      return deny(DENY.policy);
    }
    default:
      return deny(DENY.policy);
  }
}

function isAllowedPair(to: string, selector: string, deployment: Pick<Deployment, "market" | "selioVault">): boolean {
  if (to === deployment.market.toLowerCase()) {
    return selector === SELECTORS.sellNow || selector === SELECTORS.placeBid || selector === SELECTORS.cancelBid;
  }
  return to === deployment.selioVault.toLowerCase() && selector === SELECTORS.deposit;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An integer from a JSON number, a decimal string or a 0x hex string; null otherwise. */
function toInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    const n = BigInt(value);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
  }
  return null;
}
