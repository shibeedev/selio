import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;
export type Row = NonNullable<ReturnType<ReturnType<Db["prepare"]>["get"]>>;
export type Transactional = <T>(fn: (tx: Db) => T) => T;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

export function transaction<T>(db: Db, fn: (tx: Db) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function createTransactional(db: Db): Transactional {
  return (fn) => transaction(db, fn);
}

export function pingDatabase(db: Db): boolean {
  try {
    db.prepare("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`column ${column} is not text`);
  return value;
}

export function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  return value === null || value === undefined ? null : str(row, column);
}

export function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`column ${column} is not a number`);
}

export function numOrNull(row: Row, column: string): number | null {
  const value = row[column];
  return value === null || value === undefined ? null : num(row, column);
}
