import { str, type Db } from "../../shared/db/database.js";

/** One transaction the agent is about to sign; Transaction Review proceeds only for a matching intent. */
export interface Intent {
  id: string;
  walletId: string;
  chainId: number;
  to: string;
  dataHash: string;
  nonce: number;
  expiresAt: number;
}

export class IntentRepository {
  constructor(private readonly db: Db) {}

  insert(i: Intent, tx: Db = this.db): void {
    tx.prepare(
      "INSERT INTO intents (id, wallet_id, chain_id, to_addr, data_hash, nonce, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(i.id, i.walletId, i.chainId, i.to.toLowerCase(), i.dataHash.toLowerCase(), i.nonce, i.expiresAt);
  }

  /** The id of an unused, unexpired intent for exactly this transaction, if one exists. */
  findMatch(
    m: { walletId: string; chainId: number; to: string; nonce: number; dataHash: string; now: number },
    tx: Db = this.db,
  ): string | null {
    const row = tx
      .prepare(
        `SELECT id FROM intents WHERE wallet_id = ? AND to_addr = ? AND nonce = ? AND chain_id = ? AND data_hash = ?
           AND used = 0 AND expires_at > ? LIMIT 1`,
      )
      .get(m.walletId, m.to.toLowerCase(), m.nonce, m.chainId, m.dataHash.toLowerCase(), m.now);
    return row ? str(row, "id") : null;
  }

  markUsed(id: string, tx: Db = this.db): boolean {
    return Number(tx.prepare("UPDATE intents SET used = 1 WHERE id = ? AND used = 0").run(id).changes) === 1;
  }

  pruneExpired(now: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM intents WHERE expires_at <= ?").run(now);
  }
}
