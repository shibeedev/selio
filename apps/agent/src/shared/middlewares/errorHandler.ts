import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, ErrorCode } from "../errors/AppError.js";
import { errorFields, type Logger } from "./logger.js";

/** The only place that shapes error responses: `{ code, message, details? }`. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  const log = logger.child({ module: "http" });
  return (err, req, res, next) => {
    if (res.headersSent) {
      log.error({ error: errorFields(err), requestId: req.id }, "error after response started");
      next(err);
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        code: ErrorCode.VALIDATION_ERROR,
        message: "Invalid request",
        details: err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) log.error({ code: err.code, requestId: req.id }, err.message);
      res.status(err.statusCode).json({
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      });
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ code: ErrorCode.INVALID_JSON, message: "Request body is not valid JSON" });
      return;
    }
    if (type === "entity.too.large") {
      res.status(413).json({ code: ErrorCode.PAYLOAD_TOO_LARGE, message: "Request body is too large" });
      return;
    }
    log.error({ error: errorFields(err), requestId: req.id }, "unhandled error");
    res.status(500).json({ code: ErrorCode.INTERNAL_ERROR, message: "Internal server error" });
  };
}
