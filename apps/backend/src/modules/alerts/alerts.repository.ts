import { num, numOrNull, str, strOrNull, type Db, type Row } from "../../shared/db/database.js";
import type { AlertEventRow, AlertRow, NewAlertEvent } from "./alerts.model.js";

function toAlert(row: Row): AlertRow {
  return {
    id: str(row, "id"),
    owner: str(row, "owner"),
    network: str(row, "network"),
    thresholdBps: num(row, "threshold_bps"),
    webhookUrl: strOrNull(row, "webhook_url"),
    lastUtilizationBps: numOrNull(row, "last_utilization_bps"),
    createdAt: num(row, "created_at"),
  };
}

function toEvent(row: Row): AlertEventRow {
  return {
    id: num(row, "id"),
    alertId: str(row, "alert_id"),
    owner: str(row, "owner"),
    network: str(row, "network"),
    utilizationBps: num(row, "utilization_bps"),
    thresholdBps: num(row, "threshold_bps"),
    at: num(row, "at"),
  };
}

export class AlertRepository {
  constructor(private readonly db: Db) {}

  insert(a: AlertRow, tx: Db = this.db): void {
    tx.prepare(
      "INSERT INTO alerts (id, owner, network, threshold_bps, webhook_url, last_utilization_bps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(a.id, a.owner, a.network, a.thresholdBps, a.webhookUrl, a.lastUtilizationBps, a.createdAt);
  }

  findById(id: string, tx: Db = this.db): AlertRow | null {
    const row = tx.prepare("SELECT * FROM alerts WHERE id = ?").get(id);
    return row ? toAlert(row) : null;
  }

  listByOwner(owner: string, tx: Db = this.db): AlertRow[] {
    return tx.prepare("SELECT * FROM alerts WHERE owner = ? ORDER BY created_at DESC, id").all(owner).map(toAlert);
  }

  listByNetwork(network: string, tx: Db = this.db): AlertRow[] {
    return tx.prepare("SELECT * FROM alerts WHERE network = ?").all(network).map(toAlert);
  }

  countByOwner(owner: string, tx: Db = this.db): number {
    return num(tx.prepare("SELECT COUNT(*) AS n FROM alerts WHERE owner = ?").get(owner), "n");
  }

  delete(id: string, tx: Db = this.db): void {
    tx.prepare("DELETE FROM alerts WHERE id = ?").run(id);
  }

  setLastUtilization(network: string, utilizationBps: number, tx: Db = this.db): void {
    tx.prepare("UPDATE alerts SET last_utilization_bps = ? WHERE network = ?").run(utilizationBps, network);
  }

  insertEvents(events: NewAlertEvent[], tx: Db = this.db): AlertEventRow[] {
    const insert = tx.prepare(
      "INSERT INTO alert_events (alert_id, owner, network, utilization_bps, threshold_bps, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    return events.map((e) => {
      const result = insert.run(e.alertId, e.owner, e.network, e.utilizationBps, e.thresholdBps, e.at);
      return { id: Number(result.lastInsertRowid), ...e };
    });
  }

  listEventsByOwner(owner: string, limit: number, tx: Db = this.db): AlertEventRow[] {
    return tx
      .prepare("SELECT * FROM alert_events WHERE owner = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(owner, limit)
      .map(toEvent);
  }
}

export type AlertRepositoryPort = Pick<
  AlertRepository,
  | "insert"
  | "findById"
  | "listByOwner"
  | "listByNetwork"
  | "countByOwner"
  | "delete"
  | "setLastUtilization"
  | "insertEvents"
  | "listEventsByOwner"
>;
