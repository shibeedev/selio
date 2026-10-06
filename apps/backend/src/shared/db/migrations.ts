import { transaction, type Db } from "./database.js";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

// Never edit an applied migration; append a new one.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    up: `
      CREATE TABLE capacity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network TEXT NOT NULL,
        at INTEGER NOT NULL,
        utilization_bps INTEGER NOT NULL,
        withdrawable TEXT NOT NULL,
        supplied TEXT NOT NULL,
        debtor_capacity TEXT NOT NULL,
        session_assets TEXT NOT NULL
      );
      CREATE INDEX idx_capacity_snapshots_network_at ON capacity_snapshots (network, at);

      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        network TEXT NOT NULL,
        threshold_bps INTEGER NOT NULL,
        webhook_url TEXT,
        last_utilization_bps INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_alerts_owner ON alerts (owner);
      CREATE INDEX idx_alerts_network ON alerts (network);

      CREATE TABLE alert_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        network TEXT NOT NULL,
        utilization_bps INTEGER NOT NULL,
        threshold_bps INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_alert_events_owner_at ON alert_events (owner, at);

      CREATE TABLE faucet_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network TEXT NOT NULL,
        address TEXT NOT NULL,
        kit TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX idx_faucet_grants_lookup ON faucet_grants (network, address, kit, at);

      CREATE TABLE faucet_locks (
        network TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
    down:
      "DROP TABLE faucet_locks; DROP TABLE faucet_grants; DROP TABLE alert_events; DROP TABLE alerts; DROP TABLE capacity_snapshots;",
  },
  {
    version: 2,
    name: "security",
    up: `
      CREATE TABLE auth_nonces (
        nonce TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_auth_nonces_expires_at ON auth_nonces (expires_at);

      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions (expires_at);

      CREATE TABLE rate_limit_hits (
        key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        hits INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (key, window_start)
      );
      CREATE INDEX idx_rate_limit_hits_expires_at ON rate_limit_hits (expires_at);

      ALTER TABLE faucet_grants ADD COLUMN ip TEXT;
      CREATE INDEX idx_faucet_grants_ip_at ON faucet_grants (ip, at);
    `,
    // The index goes first: SQLite cannot drop an indexed column.
    down:
      "DROP INDEX idx_faucet_grants_ip_at; ALTER TABLE faucet_grants DROP COLUMN ip; DROP TABLE rate_limit_hits; DROP TABLE auth_sessions; DROP TABLE auth_nonces;",
  },
];

function ensureTable(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
}

function appliedVersions(db: Db): Set<number> {
  return new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row.version)),
  );
}

export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): void {
  ensureTable(db);
  const applied = appliedVersions(db);
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    transaction(db, (tx) => {
      tx.exec(m.up);
      tx.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now(),
      );
    });
  }
}

/** Reverts every applied migration newer than `version`, newest first. */
export function rollback(db: Db, version: number, migrations: Migration[] = MIGRATIONS): void {
  ensureTable(db);
  const applied = appliedVersions(db);
  for (const m of [...migrations].sort((a, b) => b.version - a.version)) {
    if (m.version <= version || !applied.has(m.version)) continue;
    transaction(db, (tx) => {
      tx.exec(m.down);
      tx.prepare("DELETE FROM schema_migrations WHERE version = ?").run(m.version);
    });
  }
}
