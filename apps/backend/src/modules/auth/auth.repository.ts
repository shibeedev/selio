import { num, str, type Db } from "../../shared/db/database.js";
import type { AuthSessionRow } from "./auth.model.js";

export class AuthRepository {
  constructor(private readonly db: Db) {}

  insertNonce(nonce: string, address: string, expiresAt: number, tx: Db = this.db): void {
    tx.prepare("INSERT INTO auth_nonces (nonce, address, expires_at) VALUES (?, ?, ?)").run(nonce, address, expiresAt);
  }

  /** True when exactly one live nonce issued for `address` was consumed. */
  consumeNonce(nonce: string, address: string, now: number, tx: Db = this.db): boolean {
    const result = tx
      .prepare("DELETE FROM auth_nonces WHERE nonce = ? AND address = ? AND expires_at > ?")
      .run(nonce, address, now);
    return Number(result.changes) === 1;
  }

  deleteExpiredNonces(now: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM auth_nonces WHERE expires_at <= ?").run(now);
  }

  insertSession(tokenHash: string, owner: string, createdAt: number, expiresAt: number, tx: Db = this.db): void {
    tx.prepare("INSERT INTO auth_sessions (token_hash, owner, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
      tokenHash,
      owner,
      createdAt,
      expiresAt,
    );
  }

  findSession(tokenHash: string, tx: Db = this.db): Pick<AuthSessionRow, "owner" | "expiresAt"> | null {
    const row = tx.prepare("SELECT owner, expires_at FROM auth_sessions WHERE token_hash = ?").get(tokenHash);
    return row ? { owner: str(row, "owner"), expiresAt: num(row, "expires_at") } : null;
  }

  deleteExpiredSessions(now: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  }
}

export type AuthRepositoryPort = Pick<
  AuthRepository,
  "insertNonce" | "consumeNonce" | "deleteExpiredNonces" | "insertSession" | "findSession" | "deleteExpiredSessions"
>;
