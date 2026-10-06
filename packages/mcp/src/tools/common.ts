import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { NetworkKey, TokenInfo, UnsignedTx } from "@selio/sdk";
import { amountView } from "../amounts.js";
import type { MarketSdk, NetworkHandle, SelioChain } from "../chain.js";
import { ToolError } from "../errors.js";

export interface ToolContext {
  chain: SelioChain;
  /** Wall-clock time in seconds; injectable for tests. */
  nowSeconds?: () => bigint;
  /** GraphQL endpoint of the Selio event index, read by get_history. */
  indexerUrl?: string;
}

export interface TxView {
  to: Address;
  data: Hex;
  /** Native value in wei, as a decimal string. */
  value: string;
  description: string;
}

export interface BuildResult {
  network: NetworkKey;
  chainId: number;
  /** Unsigned transactions, to be signed and sent in order by the user's wallet. */
  transactions: TxView[];
  notes: string[];
  details?: Record<string, unknown>;
}

export const UNSIGNED_NOTE =
  "These transactions are unsigned. Sign and send them in order from the user's wallet; Selio never signs. Run simulate_transaction on each one right before sending it, after the earlier ones are confirmed.";

export function txView(tx: UnsignedTx): TxView {
  return { to: tx.to, data: tx.data, value: tx.value.toString(), description: tx.description };
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function toAddress(input: string, field: string): Address {
  if (!isAddress(input, { strict: false })) throw new ToolError(`${field} is not a valid address: ${input}`);
  return getAddress(input);
}

export function optionalAddress(input: string | undefined, field: string): Address | undefined {
  return input === undefined ? undefined : toAddress(input, field);
}

export function toId(input: number | string): bigint {
  return BigInt(input);
}

export function requireAave(h: NetworkHandle, tool: string): void {
  if (h.deployment.venue !== "aave") {
    throw new ToolError(
      `${tool} is only available on Aave networks (usdt0-replay). On Morpho, collateral is never lent out, so it can be withdrawn directly whenever the position stays healthy.`,
    );
  }
}

export interface ResolvedPayToken {
  token: TokenInfo;
  index: number;
}

/** Finds a market payment token by symbol (case-insensitive) or address. */
export async function resolvePayToken(sdk: MarketSdk, input: string): Promise<ResolvedPayToken> {
  const tokens = await sdk.payTokens();
  const byAddress = isAddress(input, { strict: false });
  const symbol = input.trim().toLowerCase();
  const index = tokens.findIndex((t) => (byAddress ? sameAddress(t.address, input) : t.symbol.toLowerCase() === symbol));
  const token = tokens[index];
  if (!token) {
    throw new ToolError(
      `"${input}" is not a payment token of this market. Accepted: ${tokens.map((t) => `${t.symbol} (${t.address})`).join(", ")}`,
    );
  }
  return { token, index };
}

/** Resolves a list of payment tokens (default: all) into tokens and the matching bit mask. */
export async function resolvePayTokens(
  sdk: MarketSdk,
  inputs: string[] | undefined,
): Promise<{ tokens: TokenInfo[]; mask: number }> {
  if (inputs === undefined) {
    const tokens = await sdk.payTokens();
    return { tokens, mask: (1 << tokens.length) - 1 };
  }
  const resolved = await Promise.all(inputs.map((input) => resolvePayToken(sdk, input)));
  let mask = 0;
  for (const r of resolved) mask |= 1 << r.index;
  return { tokens: resolved.map((r) => r.token), mask };
}

/**
 * Approval needed before a contract pulls `amount` of `token` from `owner`. With `owner` the current allowance is
 * checked; without it the approval is always included.
 */
export async function approvalIfNeeded(
  sdk: MarketSdk,
  token: TokenInfo,
  owner: Address | undefined,
  spender: Address,
  amount: bigint,
  spenderLabel: string,
): Promise<{ transactions: UnsignedTx[]; notes: string[] }> {
  const view = amountView(amount, token);
  const approve: UnsignedTx = {
    ...sdk.approve(token.address, spender, amount),
    description: `Approve ${spenderLabel} (${spender}) to spend ${view.human} ${token.symbol}`,
  };
  if (owner === undefined) {
    return {
      transactions: [approve],
      notes: [
        `The ${token.symbol} approval is included because no "from" address was given; pass "from" to skip it when the allowance already covers ${view.human} ${token.symbol}.`,
      ],
    };
  }
  const current = await sdk.allowance(token.address, owner, spender);
  return current >= amount ? { transactions: [], notes: [] } : { transactions: [approve], notes: [] };
}

export function buildResult(
  h: NetworkHandle,
  key: NetworkKey,
  transactions: UnsignedTx[],
  notes: string[],
  details?: Record<string, unknown>,
): BuildResult {
  return {
    network: key,
    chainId: h.deployment.chainId,
    transactions: transactions.map(txView),
    notes: [...notes, UNSIGNED_NOTE],
    ...(details === undefined ? {} : { details }),
  };
}

/** Amount stored under `address` in a per-token record (case-insensitive key match). */
export function amountFor(record: Record<string, bigint>, address: string): bigint {
  for (const [key, value] of Object.entries(record)) if (sameAddress(key, address)) return value;
  return 0n;
}
