import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const VALID_ID = /^[\w.:-]{1,128}$/;

/** Reuses a well-formed incoming `x-request-id`, else generates one, and echoes it in the response. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
