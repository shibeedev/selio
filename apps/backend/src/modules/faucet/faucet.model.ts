export interface FaucetGrantRow {
  id: number;
  network: string;
  address: string;
  kit: string;
  at: number;
  /** The caller's IP bucket; null for grants written before the per-IP budget existed. */
  ip: string | null;
}
