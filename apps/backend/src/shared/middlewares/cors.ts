import type { RequestHandler } from "express";

const ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const ALLOW_HEADERS =
  "Content-Type, Accept, Authorization, X-Request-Id, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID";
// Retry-After lets a browser client (viem's HTTP transport) back off after a 429.
const EXPOSE_HEADERS = "X-Request-Id, Mcp-Session-Id, Retry-After";

/** `origins` is "*" or a comma-separated allow-list; unlisted origins are still served, only without ACAO. */
export function cors(origins: string): RequestHandler {
  const anyOrigin = origins === "*";
  const allowed = new Set(
    origins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );
  return (req, res, next) => {
    if (anyOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      res.vary("Origin");
      const origin = req.headers.origin;
      if (origin && allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS);
    res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS);
    res.setHeader("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
