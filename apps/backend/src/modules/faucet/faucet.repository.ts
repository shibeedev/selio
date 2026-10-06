import { num, numOrNull, type Db } from "../../shared/db/database.js";
import type { FaucetGrantRow } from "./faucet.model.js";

export class FaucetRepository {
  constructor(private readonly db: Db) {}

  lastGrantAt(network: string, address: string, kit: string, tx: Db = this.db): number | null {
    const row = tx
      .prepare("SELECT MAX(at) AS last FROM faucet_grants WHERE network = ? AND address = ? AND kit = ?")
      .get(network, address, kit);
    return row ? numOrNull(row, "last") : null;
  }

  insertGrant(grant: Omit<FaucetGrantRow, "id">, tx: Db = this.db): number {
    const result = tx
      .prepare("INSERT INTO faucet_grants (network, address, kit, at, ip) VALUES (?, ?, ?, ?, ?)")
      .run(grant.network, grant.address, grant.kit, grant.at, grant.ip);
    return Number(result.lastInsertRowid);
  }

  deleteGrant(id: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM faucet_grants WHERE id = ?").run(id);
  }

  deleteGrantsBefore(cutoffMs: number, tx: Db = this.db): void {
    tx.prepare("DELETE FROM faucet_grants WHERE at < ?").run(cutoffMs);
  }

  ipUsage(ip: string, sinceMs: number, tx: Db = this.db): { grants: number; addresses: number; first: number | null } {
    const row = tx
      .prepare(
        "SELECT COUNT(*) AS grants, COUNT(DISTINCT address) AS addresses, MIN(at) AS first FROM faucet_grants WHERE ip = ? AND at >= ?",
      )
      .get(ip, sinceMs);
    return { grants: num(row, "grants"), addresses: num(row, "addresses"), first: numOrNull(row, "first") };
  }

  ipHasAddress(ip: string, address: string, sinceMs: number, tx: Db = this.db): boolean {
    return (
      tx.prepare("SELECT 1 AS hit FROM faucet_grants WHERE ip = ? AND address = ? AND at >= ? LIMIT 1").get(ip, address, sinceMs) !==
      undefined
    );
  }

  /**
   * Kit runs impersonate shared helper accounts, so they must not interleave on one fork: one lock row per network,
   * taken over by the next acquirer once it has expired.
   */
  tryAcquireLock(network: string, holder: string, now: number, ttlMs: number, tx: Db = this.db): boolean {
    const result = tx
      .prepare(
        "INSERT INTO faucet_locks (network, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (network) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE faucet_locks.expires_at < ?",
      )
      .run(network, holder, now + ttlMs, now);
    return Number(result.changes) === 1;
  }

  releaseLock(network: string, holder: string, tx: Db = this.db): void {
    tx.prepare("DELETE FROM faucet_locks WHERE network = ? AND holder = ?").run(network, holder);
  }
}

export type FaucetRepositoryPort = Pick<
  FaucetRepository,
  | "lastGrantAt"
  | "insertGrant"
  | "deleteGrant"
  | "deleteGrantsBefore"
  | "ipUsage"
  | "ipHasAddress"
  | "tryAcquireLock"
  | "releaseLock"
>;
