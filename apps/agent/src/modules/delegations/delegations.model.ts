export type DelegationStatus = "active" | "revoked" | "invalid";

/** A row of `delegations`; the share and the wallet API key are stored only sealed (E.7). */
export interface DelegationRow {
  walletId: string;
  userId: string;
  address: string;
  shareSetId: string | null;
  sealedShare: string | null;
  sealedApiKey: string | null;
  status: DelegationStatus;
  /** ms of the Dynamic event that set the state; orders out-of-order deliveries. */
  eventAt: number;
  createdAt: number;
  updatedAt: number;
}
