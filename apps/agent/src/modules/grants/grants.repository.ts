import { num, numOrNull, str, type Db, type Row } from "../../shared/db/database.js";
import type { GrantKind, GrantRow, GrantStatus } from "./grants.model.js";

const COLUMNS =
  "id, address, user_id, network, kind, alert_id, threshold_bps, max_per_action, max_total, used_total, " +
  "max_sell_discount_bps, pay_mask, min_bid_discount_bps, pay_idx, expires_at, status, created_at, updated_at";

function toGrant(row: Row): GrantRow {
  return {
    id: str(row, "id"),
    address: str(row, "address"),
    userId: str(row, "user_id"),
    network: str(row, "network") as GrantRow["network"],
    kind: str(row, "kind") as GrantKind,
    alertId: str(row, "alert_id"),
    thresholdBps: num(row, "threshold_bps"),
    maxPerAction: BigInt(str(row, "max_per_action")),
    maxTotal: BigInt(str(row, "max_total")),
    usedTotal: BigInt(str(row, "used_total")),
    maxSellDiscountBps: numOrNull(row, "max_sell_discount_bps"),
    payMask: numOrNull(row, "pay_mask"),
    minBidDiscountBps: numOrNull(row, "min_bid_discount_bps"),
    payIdx: numOrNull(row, "pay_idx"),
    expiresAt: num(row, "expires_at"),
    status: str(row, "status") as GrantStatus,
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export class GrantRepository {
  constructor(private readonly db: Db) {}

  insert(g: GrantRow, tx: Db = this.db): void {
    tx.prepare(`INSERT INTO grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      g.id,
      g.address,
      g.userId,
      g.network,
      g.kind,
      g.alertId,
      g.thresholdBps,
      g.maxPerAction.toString(),
      g.maxTotal.toString(),
      g.usedTotal.toString(),
      g.maxSellDiscountBps,
      g.payMask,
      g.minBidDiscountBps,
      g.payIdx,
      g.expiresAt,
      g.status,
      g.createdAt,
      g.updatedAt,
    );
  }

  find(id: string, tx: Db = this.db): GrantRow | null {
    const row = tx.prepare(`SELECT ${COLUMNS} FROM grants WHERE id = ?`).get(id);
    return row ? toGrant(row) : null;
  }

  findActive(address: string, network: string, kind: GrantKind, tx: Db = this.db): GrantRow | null {
    const row = tx
      .prepare(`SELECT ${COLUMNS} FROM grants WHERE address = ? AND network = ? AND kind = ? AND status = 'active'`)
      .get(address, network, kind);
    return row ? toGrant(row) : null;
  }

  /** Every grant of the address, newest first. */
  listByAddress(address: string, tx: Db = this.db): GrantRow[] {
    return tx
      .prepare(`SELECT ${COLUMNS} FROM grants WHERE address = ? ORDER BY created_at DESC, rowid DESC`)
      .all(address)
      .map(toGrant);
  }

  /** Marks the address's active grants whose expiry has passed as expired. */
  expireDue(address: string, now: number, tx: Db = this.db): void {
    tx.prepare(
      "UPDATE grants SET status = 'expired', updated_at = ? WHERE address = ? AND status = 'active' AND expires_at <= ?",
    ).run(now, address, now);
  }

  setStatus(id: string, status: GrantStatus, now: number, tx: Db = this.db): void {
    tx.prepare("UPDATE grants SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  }

  revokeAllForAddress(address: string, now: number, tx: Db = this.db): void {
    tx.prepare("UPDATE grants SET status = 'revoked', updated_at = ? WHERE address = ? AND status != 'revoked'").run(
      now,
      address,
    );
  }

  /**
   * Adds `delta` (negative for a cancelled standing bid) to the used total, never below zero;
   * an active grant whose used total reaches its total budget becomes exhausted.
   */
  addUsed(id: string, delta: bigint, now: number, tx: Db = this.db): void {
    const grant = this.find(id, tx);
    if (!grant) return;
    const sum = grant.usedTotal + delta;
    const used = sum > 0n ? sum : 0n;
    const status: GrantStatus = grant.status === "active" && used >= grant.maxTotal ? "exhausted" : grant.status;
    tx.prepare("UPDATE grants SET used_total = ?, status = ?, updated_at = ? WHERE id = ?").run(used.toString(), status, now, id);
  }
}
