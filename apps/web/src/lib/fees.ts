import { isAddressEqual, type Address } from "viem";
import type { SellerQuote, TokenInfo } from "@selio/sdk";
import { formatBps, formatToken } from "./format";

/** Label of every fee row: "Fee 0.2%" from the market's FEE_BPS. */
export function feeLabel(feeBps: number): string {
  return `Fee ${formatBps(feeBps, 1)}`;
}

export function findToken(tokens: readonly TokenInfo[], address: Address): TokenInfo | undefined {
  return tokens.find((t) => isAddressEqual(t.address, address));
}

/** A plan's amount for one pay token, whatever the letter case of its key. */
export function amountFor(amounts: Record<Address, bigint>, token: Address): bigint {
  for (const [address, amount] of Object.entries(amounts)) {
    if (isAddressEqual(address as Address, token)) return amount;
  }
  return 0n;
}

/**
 * A sell plan's amounts per pay token (proceeds, fees or what the seller receives), in plan order and joined
 * with " + "; a token outside the market's list shows its raw amount and address.
 */
export function formatPlanAmounts(amounts: Record<Address, bigint>, tokens: readonly TokenInfo[], underlying: TokenInfo): string {
  const entries = Object.entries(amounts) as [Address, bigint][];
  if (entries.length === 0) return `0 ${underlying.symbol}`;
  return entries
    .map(([address, amount]) => {
      const token = findToken(tokens, address);
      return token ? formatToken(amount, token) : `${amount} of ${address}`;
    })
    .join(" + ");
}

/** Amounts of past fills per pay token ("Your sales"); a token outside the market's list shows its raw amount. */
export function formatFillAmounts(entries: readonly { token: Address; amount: bigint }[], tokens: readonly TokenInfo[]): string {
  if (entries.length === 0) return "0";
  return entries
    .map(({ token, amount }) => {
      const info = findToken(tokens, token);
      return info ? formatToken(amount, info) : String(amount);
    })
    .join(" + ");
}

/** The auction's fee rows in the underlying's value, at the start discount and at the cap. */
export function auctionFeeRows(
  atStart: SellerQuote,
  atCap: SellerQuote,
  startBps: number,
  capBps: number,
  underlying: TokenInfo,
): { fee: string; receive: string } {
  const start = formatBps(startBps);
  const cap = formatBps(capBps);
  return {
    fee: `${formatToken(atStart.fee, underlying)} at ${start} off, ${formatToken(atCap.fee, underlying)} at ${cap} off`,
    receive: `${formatToken(atStart.sellerNet, underlying)} at ${start} off, down to ${formatToken(atCap.sellerNet, underlying)} at ${cap} off`,
  };
}
