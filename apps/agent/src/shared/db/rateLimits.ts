import { num, type Db } from "./database.js";

/** Fixed-window request counters in SQLite (same layout and use as the backend). */
export class RateLimits {
  constructor(private readonly db: Db) {}

  hit(key: string, windowMs: number, now: number): { hits: number; resetAt: number } {
    const windowStart = now - (now % windowMs);
    const resetAt = windowStart + windowMs;
    const row = this.db
      .prepare(
        "INSERT INTO rate_limit_hits (key, window_start, hits, expires_at) VALUES (?, ?, 1, ?) " +
          "ON CONFLICT (key, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits",
      )
      .get(key, windowStart, resetAt);
    return { hits: row ? num(row, "hits") : 1, resetAt };
  }

  prune(now: number): void {
    this.db.prepare("DELETE FROM rate_limit_hits WHERE expires_at <= ?").run(now);
  }
}

export type RateLimitPort = Pick<RateLimits, "hit" | "prune">;
