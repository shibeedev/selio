import type { RequestHandler } from "express";

export function cors(origins: string): RequestHandler {
  const allowed = origins === "*" ? null : origins.split(",").map((o) => o.trim()).filter(Boolean);
  return (req, res, next) => {
    if (allowed === null) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      res.append("Vary", "Origin");
      const origin = req.headers.origin;
      if (typeof origin === "string" && allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, X-Request-Id");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
