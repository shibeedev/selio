import type { RequestHandler, Response } from "express";
import { AppError } from "../../shared/errors/AppError.js";
import type { SessionPort } from "./auth.types.js";

const BEARER = /^bearer\s+(\S+)\s*$/i;

/** The session gate of the alert routes: a valid `Authorization: Bearer <token>` sets `res.locals.sessionOwner`. */
export function requireSession(sessions: SessionPort): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const token = typeof header === "string" ? BEARER.exec(header)?.[1] : undefined;
    if (!token) {
      next(new AppError(401, "UNAUTHORIZED", "Sign in with your wallet to manage alerts"));
      return;
    }
    const owner = sessions.authenticate(token);
    if (!owner) {
      next(new AppError(401, "UNAUTHORIZED", "Your sign-in has expired or is not valid; sign in again"));
      return;
    }
    res.locals.sessionOwner = owner;
    next();
  };
}

/** The lowercase address the request's session belongs to (set by `requireSession`). */
export function sessionOwner(res: Response): string {
  return String(res.locals.sessionOwner);
}
