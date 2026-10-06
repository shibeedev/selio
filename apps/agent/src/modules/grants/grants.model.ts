export type GrantKind = "sell" | "bid" | "vault";
export type GrantStatus = "active" | "revoked" | "expired" | "exhausted";

/** A row of `grants`; amounts are underlying base units. */
export interface GrantRow {
  id: string;
  address: string;
  userId: string;
  network: "monad-testnet";
  kind: GrantKind;
  alertId: string;
  thresholdBps: number;
  maxPerAction: bigint;
  maxTotal: bigint;
  usedTotal: bigint;
  maxSellDiscountBps: number | null;
  payMask: number | null;
  minBidDiscountBps: number | null;
  payIdx: number | null;
  expiresAt: number;
  status: GrantStatus;
  createdAt: number;
  updatedAt: number;
}
