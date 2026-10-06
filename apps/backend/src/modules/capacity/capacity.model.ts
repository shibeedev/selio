export interface CapacitySnapshotRow {
  id: number;
  network: string;
  at: number;
  utilizationBps: number;
  withdrawable: string;
  supplied: string;
  debtorCapacity: string;
  sessionAssets: string;
}
