import { num, str, type Db, type Row } from "../../shared/db/database.js";
import type { CapacitySnapshotRow } from "./capacity.model.js";

function toRow(row: Row): CapacitySnapshotRow {
  return {
    id: num(row, "id"),
    network: str(row, "network"),
    at: num(row, "at"),
    utilizationBps: num(row, "utilization_bps"),
    withdrawable: str(row, "withdrawable"),
    supplied: str(row, "supplied"),
    debtorCapacity: str(row, "debtor_capacity"),
    sessionAssets: str(row, "session_assets"),
  };
}

export class CapacityRepository {
  constructor(private readonly db: Db) {}

  insertMany(rows: Omit<CapacitySnapshotRow, "id">[], tx: Db = this.db): void {
    const insert = tx.prepare(
      "INSERT INTO capacity_snapshots (network, at, utilization_bps, withdrawable, supplied, debtor_capacity, session_assets) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      insert.run(r.network, r.at, r.utilizationBps, r.withdrawable, r.supplied, r.debtorCapacity, r.sessionAssets);
    }
  }

  listSince(network: string, sinceMs: number, tx: Db = this.db): CapacitySnapshotRow[] {
    return tx
      .prepare("SELECT * FROM capacity_snapshots WHERE network = ? AND at >= ? ORDER BY at ASC, id ASC")
      .all(network, sinceMs)
      .map(toRow);
  }

  deleteOlderThan(cutoffMs: number, tx: Db = this.db): number {
    return Number(tx.prepare("DELETE FROM capacity_snapshots WHERE at < ?").run(cutoffMs).changes);
  }
}
