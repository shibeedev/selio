import { isAddressEqual, type Address } from "viem";
import type { BidView } from "@selio/sdk";

export interface BidLevel {
  discountBps: number;
  size: bigint;
  /** Receipt value all bids at or below this discount can buy. */
  cumulative: bigint;
}

export function bidLevels(bids: Pick<BidView, "minDiscountBps" | "capacityAssets">[]): BidLevel[] {
  const sizes = new Map<number, bigint>();
  for (const b of bids) {
    if (b.capacityAssets === 0n) continue;
    sizes.set(b.minDiscountBps, (sizes.get(b.minDiscountBps) ?? 0n) + b.capacityAssets);
  }
  let cumulative = 0n;
  return [...sizes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([discountBps, size]) => {
      cumulative += size;
      return { discountBps, size, cumulative };
    });
}

export type BidOwner = "vault" | "mine" | "other";

export function bidOwner(bidder: Address, vault: Address, me: Address | null): BidOwner {
  if (isAddressEqual(bidder, vault)) return "vault";
  if (me && isAddressEqual(bidder, me)) return "mine";
  return "other";
}

export const BID_OWNER_LABEL: Record<BidOwner, string> = { vault: "Selio Vault", mine: "Your bid", other: "Limit bid" };
