import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const REQUEST_ID = /^[\w.:-]{1,128}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers["x-request-id"];
    const id = typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.id = id;
    res.setHeader("x-request-id", id);
    next();
  };
}
