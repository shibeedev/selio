import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/AppError.js";
import type { Logger } from "./logger.js";

export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));
  };
}

function bodyParserType(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { type?: unknown }).type : undefined;
}

/** The only place that shapes error responses: `{ code, message, details? }`. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  const log = logger.child({ module: "http" });
  return (err, req, res, next) => {
    if (res.headersSent) {
      log.error({ err, requestId: req.id }, "error after response started");
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) log.error({ err, requestId: req.id }, err.message);
      if (err.statusCode === 401) res.setHeader("WWW-Authenticate", "Bearer");
      res
        .status(err.statusCode)
        .json(
          err.details === undefined
            ? { code: err.code, message: err.message }
            : { code: err.code, message: err.message, details: err.details },
        );
      return;
    }
    const type = bodyParserType(err);
    if (type === "entity.parse.failed") {
      res.status(400).json({ code: "INVALID_JSON", message: "Request body is not valid JSON" });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });
      return;
    }
    log.error({ err, requestId: req.id }, "unhandled error");
    res.status(500).json({ code: "INTERNAL_ERROR", message: "Internal server error" });
  };
}
