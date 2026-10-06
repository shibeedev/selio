import type { Hex } from "viem";
import { num, numOrNull, str, strOrNull, type Db, type Row } from "../../shared/db/database.js";

export type ActionKind = "sell" | "bid" | "vault" | "cancel";
export type ActionStatus = "planned" | "sending" | "done" | "failed" | "skipped";

/** A row of `actions`, the audit trail of what the agent did for a grant. */
export interface ActionRow {
  id: number;
  grantId: string;
  kind: ActionKind;
  triggerAt: number;
  utilizationBps: number | null;
  assets: string | null;
  fee: string | null;
  net: string | null;
  status: ActionStatus;
  txHashes: Hex[];
  bidId: string | null;
  message: string | null;
  createdAt: number;
  updatedAt: number;
}

const COLUMNS =
  "actions.id, actions.grant_id, actions.kind, actions.trigger_at, actions.utilization_bps, actions.assets, actions.fee, " +
  "actions.net, actions.status, actions.tx_hashes, actions.bid_id, actions.message, actions.created_at, actions.updated_at";

function toAction(row: Row): ActionRow {
  return {
    id: num(row, "id"),
    grantId: str(row, "grant_id"),
    kind: str(row, "kind") as ActionKind,
    triggerAt: num(row, "trigger_at"),
    utilizationBps: numOrNull(row, "utilization_bps"),
    assets: strOrNull(row, "assets"),
    fee: strOrNull(row, "fee"),
    net: strOrNull(row, "net"),
    status: str(row, "status") as ActionStatus,
    txHashes: JSON.parse(str(row, "tx_hashes")) as Hex[],
    bidId: strOrNull(row, "bid_id"),
    message: strOrNull(row, "message"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
  };
}

export interface NewAction {
  grantId: string;
  kind: ActionKind;
  triggerAt: number;
  utilizationBps: number | null;
  status: "planned" | "skipped";
  message: string | null;
}

export class ActionRepository {
  constructor(private readonly db: Db) {}

  /** Inserts an action; null when the grant already has an action of that kind for that trigger. */
  insert(a: NewAction, now: number, tx: Db = this.db): number | null {
    const result = tx
      .prepare(
        `INSERT INTO actions (grant_id, kind, trigger_at, utilization_bps, status, message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (grant_id, kind, trigger_at) DO NOTHING`,
      )
      .run(a.grantId, a.kind, a.triggerAt, a.utilizationBps, a.status, a.message, now, now);
    return Number(result.changes) === 1 ? Number(result.lastInsertRowid) : null;
  }

  find(id: number, tx: Db = this.db): ActionRow | null {
    const row = tx.prepare(`SELECT ${COLUMNS} FROM actions WHERE id = ?`).get(id);
    return row ? toAction(row) : null;
  }

  exists(grantId: string, kind: ActionKind, triggerAt: number, tx: Db = this.db): boolean {
    return (
      tx.prepare("SELECT 1 FROM actions WHERE grant_id = ? AND kind = ? AND trigger_at = ?").get(grantId, kind, triggerAt) !==
      undefined
    );
  }

  /** When the grant's latest action that was not skipped started. */
  lastStartedAt(grantId: string, tx: Db = this.db): number | null {
    const row = tx
      .prepare("SELECT MAX(created_at) AS at FROM actions WHERE grant_id = ? AND status != 'skipped'")
      .get(grantId);
    return row ? numOrNull(row, "at") : null;
  }

  /** The bid id placed by the grant's latest done bid action, if any. */
  latestDoneBidId(grantId: string, tx: Db = this.db): bigint | null {
    const row = tx
      .prepare(
        "SELECT bid_id FROM actions WHERE grant_id = ? AND kind = 'bid' AND status = 'done' AND bid_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get(grantId);
    return row ? BigInt(str(row, "bid_id")) : null;
  }

  /** The address's actions across its grants, newest first. */
  listForAddress(address: string, limit: number, tx: Db = this.db): ActionRow[] {
    return tx
      .prepare(
        `SELECT ${COLUMNS} FROM actions JOIN grants ON grants.id = actions.grant_id
         WHERE grants.address = ? ORDER BY actions.id DESC LIMIT ?`,
      )
      .all(address, limit)
      .map(toAction);
  }

  /** Records a signed transaction's hash before it is broadcast; the committing one also carries its amounts. */
  appendHash(
    id: number,
    hash: Hex,
    fields: { assets?: string | null; fee?: string | null; net?: string | null },
    now: number,
    tx: Db = this.db,
  ): void {
    tx.prepare(
      `UPDATE actions SET status = 'sending', tx_hashes = json_insert(tx_hashes, '$[#]', ?),
         assets = COALESCE(?, assets), fee = COALESCE(?, fee), net = COALESCE(?, net), updated_at = ?
       WHERE id = ?`,
    ).run(hash, fields.assets ?? null, fields.fee ?? null, fields.net ?? null, now, id);
  }

  /** Final state of an action that is still planned or sending; false when it already ended. */
  finish(
    id: number,
    status: "done" | "failed" | "skipped",
    fields: { message?: string | null; bidId?: string | null },
    now: number,
    tx: Db = this.db,
  ): boolean {
    const result = tx
      .prepare(
        `UPDATE actions SET status = ?, message = ?, bid_id = COALESCE(?, bid_id), updated_at = ?
         WHERE id = ? AND status IN ('planned', 'sending')`,
      )
      .run(status, fields.message ?? null, fields.bidId ?? null, now, id);
    return Number(result.changes) === 1;
  }

  /** Planned and sending actions up to `maxId`, oldest first (start-up reconciliation). */
  listUnfinished(maxId: number, tx: Db = this.db): ActionRow[] {
    return tx
      .prepare(`SELECT ${COLUMNS} FROM actions WHERE status IN ('planned', 'sending') AND id <= ? ORDER BY id`)
      .all(maxId)
      .map(toAction);
  }

  maxId(tx: Db = this.db): number {
    const row = tx.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM actions").get();
    return row ? num(row, "id") : 0;
  }
}
