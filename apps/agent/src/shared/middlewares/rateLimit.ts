import type { RequestHandler } from "express";
import type { RateLimitPort } from "../db/rateLimits.js";
import { AppError, ErrorCode } from "../errors/AppError.js";
import { clientIp, ipBucket } from "../utils/clientIp.js";

/** Per-IP fixed-window limit on `/agent/v1/*` (key `api:<bucket>`); other paths are not limited. */
export function rateLimit(options: { limits: RateLimitPort; now: () => number; windowMs: number; max: number }): RequestHandler {
  const { limits, now, windowMs, max } = options;
  let lastPrune = 0;
  return (req, res, next) => {
    if (!req.path.toLowerCase().startsWith("/agent/v1/")) {
      next();
      return;
    }
    const at = now();
    if (at - lastPrune >= windowMs) {
      limits.prune(at);
      lastPrune = at;
    }
    const { hits, resetAt } = limits.hit(`api:${ipBucket(clientIp(req))}`, windowMs, at);
    if (hits > max) {
      const retryAfterSeconds = Math.ceil((resetAt - at) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      next(new AppError(429, ErrorCode.RATE_LIMITED, `Too many requests; try again in ${retryAfterSeconds}s`, { retryAfterSeconds }));
      return;
    }
    next();
  };
}
