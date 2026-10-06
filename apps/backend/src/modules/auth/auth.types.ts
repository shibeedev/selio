import type { AuthService } from "./auth.service.js";

/** How long a sign-in nonce can be used. */
export const AUTH_NONCE_TTL_MS = 5 * 60_000;
/** How long a session token stays valid; there is no sign-out, a token simply expires. */
export const AUTH_SESSION_TTL_MS = 60 * 60_000;

export interface NonceDto {
  nonce: string;
  expiresAt: number;
}

export interface SessionDto {
  token: string;
  owner: string;
  expiresAt: number;
}

export type SessionPort = Pick<AuthService, "authenticate">;
