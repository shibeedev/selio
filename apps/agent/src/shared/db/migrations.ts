import { transaction, type Db } from "./database.js";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

// Never edit an applied migration; append a new one.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    up: `
CREATE TABLE delegations (
  wallet_id      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  address        TEXT NOT NULL,
  share_set_id   TEXT,
  sealed_share   TEXT,
  sealed_api_key TEXT,
  status         TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'invalid')),
  event_at       INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX delegations_address ON delegations (address);

CREATE TABLE grants (
  id                    TEXT PRIMARY KEY,
  address               TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  network               TEXT NOT NULL CHECK (network = 'monad-testnet'),
  kind                  TEXT NOT NULL CHECK (kind IN ('sell', 'bid', 'vault')),
  alert_id              TEXT NOT NULL,
  threshold_bps         INTEGER NOT NULL,
  max_per_action        TEXT NOT NULL,
  max_total             TEXT NOT NULL,
  used_total            TEXT NOT NULL DEFAULT '0',
  max_sell_discount_bps INTEGER,
  pay_mask              INTEGER,
  min_bid_discount_bps  INTEGER,
  pay_idx               INTEGER,
  expires_at            INTEGER NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired', 'exhausted')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX grants_one_active_per_kind ON grants (address, network, kind) WHERE status = 'active';

CREATE TABLE actions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id        TEXT NOT NULL REFERENCES grants (id),
  kind            TEXT NOT NULL CHECK (kind IN ('sell', 'bid', 'vault', 'cancel')),
  trigger_at      INTEGER NOT NULL,
  utilization_bps INTEGER,
  assets          TEXT,
  fee             TEXT,
  net             TEXT,
  status          TEXT NOT NULL CHECK (status IN ('planned', 'sending', 'done', 'failed', 'skipped')),
  tx_hashes       TEXT NOT NULL DEFAULT '[]',
  bid_id          TEXT,
  message         TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (grant_id, kind, trigger_at)
);

CREATE TABLE intents (
  id         TEXT PRIMARY KEY,
  wallet_id  TEXT NOT NULL,
  chain_id   INTEGER NOT NULL,
  to_addr    TEXT NOT NULL,
  data_hash  TEXT NOT NULL,
  nonce      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX intents_lookup ON intents (wallet_id, to_addr, nonce);

CREATE TABLE webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_name  TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE rate_limit_hits (
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits         INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
`,
  },
];

export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)),
  );
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    transaction(db, (tx) => {
      tx.exec(m.up);
      tx.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
    });
  }
}
