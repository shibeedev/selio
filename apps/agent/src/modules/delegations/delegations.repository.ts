import { num, str, strOrNull, type Db, type Row } from "../../shared/db/database.js";
import type { DelegationRow, DelegationStatus } from "./delegations.model.js";

const COLUMNS =
  "wallet_id, user_id, address, share_set_id, sealed_share, sealed_api_key, status, event_at, created_at, updated_at";

function toDelegation(row: Row): DelegationRow {
  return {
    walletId: str(row, "wallet_id"),
    userId: str(row, "user_id"),
    address: str(row, "address"),
    shareSetId: strOrNull(row, "share_set_id"),
    sealedShare: strOrNull(row, "sealed_share"),
    sealedApiKey: strOrNull(row, "sealed_api_key"),
    status: str(row, "status") as DelegationStatus,
    eventAt: num(row, "event_at"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class DelegationRepository {
  constructor(private readonly db: Db) {}

  find(walletId: string, tx: Db = this.db): DelegationRow | null {
    const row = tx.prepare(`SELECT ${COLUMNS} FROM delegations WHERE wallet_id = ?`).get(walletId);
    return row ? toDelegation(row) : null;
  }

  findLatestByAddress(address: string, tx: Db = this.db): DelegationRow | null {
    const row = tx
      .prepare(`SELECT ${COLUMNS} FROM delegations WHERE address = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
      .get(address);
    return row ? toDelegation(row) : null;
  }

  save(d: Omit<DelegationRow, "createdAt" | "updatedAt">, now: number, tx: Db = this.db): void {
    tx.prepare(
      `INSERT INTO delegations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (wallet_id) DO UPDATE SET user_id = excluded.user_id, address = excluded.address,
         share_set_id = excluded.share_set_id, sealed_share = excluded.sealed_share,
         sealed_api_key = excluded.sealed_api_key, status = excluded.status, event_at = excluded.event_at,
         updated_at = excluded.updated_at`,
    ).run(d.walletId, d.userId, d.address, d.shareSetId, d.sealedShare, d.sealedApiKey, d.status, d.eventAt, now, now);
  }

  /** Leaves the current state and deletes the sealed materials. */
  end(walletId: string, status: Exclude<DelegationStatus, "active">, eventAt: number, now: number, tx: Db = this.db): void {
    tx.prepare(
      "UPDATE delegations SET status = ?, sealed_share = NULL, sealed_api_key = NULL, event_at = ?, updated_at = ? WHERE wallet_id = ?",
    ).run(status, eventAt, now, walletId);
  }

  hasEvent(eventId: string, tx: Db = this.db): boolean {
    return tx.prepare("SELECT 1 FROM webhook_events WHERE event_id = ?").get(eventId) !== undefined;
  }

  /** Records a Dynamic delivery; false when the event id was seen before. */
  recordEvent(eventId: string, eventName: string, now: number, tx: Db = this.db): boolean {
    const result = tx
      .prepare("INSERT OR IGNORE INTO webhook_events (event_id, event_name, received_at) VALUES (?, ?, ?)")
      .run(eventId, eventName, now);
    return Number(result.changes) === 1;
  }

  pruneEvents(before: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM webhook_events WHERE received_at < ?").run(before);
  }
}
