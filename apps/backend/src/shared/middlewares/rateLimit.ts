import type { RequestHandler } from "express";
import type { RateLimits } from "../db/rateLimits.js";
import { AppError } from "../errors/AppError.js";
import { clientIp, ipBucket } from "../utils/clientIp.js";

export type RateLimitGroup = "api" | "mcp" | "rpc";

export interface RequestLimits {
  windowMs: number;
  api: number;
  mcp: number;
  rpc: number;
}

export interface RateLimitOptions {
  limits: Pick<RateLimits, "hit" | "prune">;
  now: () => number;
  windowMs: number;
  max: Record<RateLimitGroup, number>;
}

/** Routing is case-insensitive, so the group is taken from the lower-cased path. */
function groupOf(path: string): RateLimitGroup | null {
  const p = path.toLowerCase();
  if (p.startsWith("/api/")) return "api";
  if (p === "/mcp" || p.startsWith("/mcp/")) return "mcp";
  if (p.startsWith("/rpc/")) return "rpc";
  return null;
}

/** Per-IP fixed-window limits on /api/*, /mcp and /rpc/*; runs before body parsing. */
export function rateLimit({ limits, now, windowMs, max }: RateLimitOptions): RequestHandler {
  let lastPrune = Number.NEGATIVE_INFINITY;
  return (req, res, next) => {
    const group = groupOf(req.path);
    if (!group) {
      next();
      return;
    }
    const t = now();
    if (t - lastPrune >= windowMs) {
      lastPrune = t;
      limits.prune(t);
    }
    const { hits, resetAt } = limits.hit(`${group}:${ipBucket(clientIp(req))}`, windowMs, t);
    if (hits <= max[group]) {
      next();
      return;
    }
    const retryAfterSeconds = Math.ceil((resetAt - t) / 1000);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    next(new AppError(429, "RATE_LIMITED", `Too many requests; try again in ${retryAfterSeconds}s`, { retryAfterSeconds }));
  };
}
