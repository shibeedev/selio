import type { RequestHandler, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError, ErrorCode } from "../errors/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

/** The verified Dynamic user of a request: its user id and the EVM addresses its token holds (lowercase). */
export interface DynamicUser {
  userId: string;
  addresses: string[];
}

export type TokenVerifier = (token: string) => Promise<DynamicUser>;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function dynamicJwks(environmentId: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`https://app.dynamicauth.com/api/v0/sdk/${environmentId}/.well-known/jwks`));
}

/**
 * RS256 against the environment's JWKS and issuer; then the token must carry the scope
 * `user:basic` (a token without it has not finished authentication), the environment id and a subject.
 */
export function createTokenVerifier(environmentId: string, keys: JWTVerifyGetKey): TokenVerifier {
  const issuer = `app.dynamicauth.com/${environmentId}`;
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { algorithms: ["RS256"], issuer });
    const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
    if (!scopes.includes("user:basic")) throw new Error("token lacks the user:basic scope");
    if (payload.environment_id !== environmentId) throw new Error("token is for another environment");
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("token has no subject");
    return { userId: payload.sub, addresses: evmAddresses(payload.verified_credentials) };
  };
}

function evmAddresses(credentials: unknown): string[] {
  if (!Array.isArray(credentials)) return [];
  const addresses = credentials
    .map((c: unknown) => (c !== null && typeof c === "object" ? (c as { address?: unknown }).address : undefined))
    .filter((a): a is string => typeof a === "string" && EVM_ADDRESS.test(a))
    .map((a) => a.toLowerCase());
  return [...new Set(addresses)];
}

/** Gate of every `/agent/v1/*` route; sets `res.locals.dynamicUser`. */
export function requireDynamicUser(verify: TokenVerifier | null): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    if (!verify) {
      throw new AppError(503, ErrorCode.DYNAMIC_NOT_CONFIGURED, "The exit agent is not configured yet");
    }
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!match) {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw new AppError(401, ErrorCode.UNAUTHORIZED, "Sign in with your email or passkey wallet first");
    }
    try {
      res.locals.dynamicUser = await verify(match[1]!);
    } catch {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw new AppError(401, ErrorCode.UNAUTHORIZED, "Your sign-in is not valid or has expired; sign in again");
    }
    next();
  });
}

export function dynamicUserOf(res: Response): DynamicUser {
  return res.locals.dynamicUser as DynamicUser;
}
