import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Forwards async handler rejections to the error handler (Express 4 does not). */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
