import { describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./database.js";
import { migrate, rollback } from "./migrations.js";

function tables(db: Db): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

function columns(db: Db, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => String(r.name));
}

describe("migrations", () => {
  it("apply once, are idempotent and reversible", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    migrate(db);
    expect(tables(db)).toEqual([
      "alert_events",
      "alerts",
      "auth_nonces",
      "auth_sessions",
      "capacity_snapshots",
      "faucet_grants",
      "faucet_locks",
      "rate_limit_hits",
      "schema_migrations",
    ]);
    expect(db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "init" },
      { version: 2, name: "security" },
    ]);
    expect(columns(db, "faucet_grants")).toContain("ip");

    rollback(db, 1);
    expect(tables(db)).toEqual(["alert_events", "alerts", "capacity_snapshots", "faucet_grants", "faucet_locks", "schema_migrations"]);
    expect(columns(db, "faucet_grants")).not.toContain("ip");

    rollback(db, 0);
    expect(tables(db)).toEqual(["schema_migrations"]);

    migrate(db);
    expect(tables(db)).toContain("alerts");
    expect(tables(db)).toContain("auth_sessions");
    db.close();
  });
});
