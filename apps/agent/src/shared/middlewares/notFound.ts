import type { RequestHandler } from "express";
import { AppError, ErrorCode } from "../errors/AppError.js";

export function notFound(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError(404, ErrorCode.NOT_FOUND, `No route for ${req.method} ${req.path}`));
  };
}
