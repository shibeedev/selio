import { num, type Db } from "./database.js";

/** Fixed-window counters in `rate_limit_hits`, shared by the per-IP request limits and the per-owner webhook rate. */
export class RateLimits {
  constructor(private readonly db: Db) {}

  /** Counts one hit for `key` in the window that contains `now`. */
  hit(key: string, windowMs: number, now: number): { hits: number; resetAt: number } {
    const windowStart = now - (now % windowMs);
    const resetAt = windowStart + windowMs;
    const row = this.db
      .prepare(
        "INSERT INTO rate_limit_hits (key, window_start, hits, expires_at) VALUES (?, ?, 1, ?) ON CONFLICT (key, window_start) DO UPDATE SET hits = hits + 1 RETURNING hits",
      )
      .get(key, windowStart, resetAt);
    return { hits: num(row, "hits"), resetAt };
  }

  prune(now: number): number {
    return Number(this.db.prepare("DELETE FROM rate_limit_hits WHERE expires_at <= ?").run(now).changes);
  }
}

export type RateLimitPort = Pick<RateLimits, "hit">;
