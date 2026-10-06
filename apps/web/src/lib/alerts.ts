import { useEffect, useState } from "react";
import { getAddress, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { ApiError, requestAlertNonce, verifyAlertSignIn } from "./api";
import { apiBaseUrl } from "./env";

/** Proof that `owner` signed in with its wallet; every alert call carries `token`. */
export interface AlertSession {
  owner: string;
  token: string;
  expiresAt: number;
}

export const SIGN_IN_STATEMENT = "Sign in to manage your Selio alerts. This sends no transaction and costs no gas.";

export const SESSION_EXPIRED_MESSAGE = "Your sign-in expired. Sign in again to see and change your alerts.";

/** EIP-4361 message; it has no expiration time, the backend's nonce and session lifetimes bound it. */
export function buildSignInMessage(p: {
  address: Address;
  chainId: number;
  nonce: string;
  domain: string;
  uri: string;
  issuedAt?: Date;
}): string {
  return createSiweMessage({
    address: getAddress(p.address),
    chainId: p.chainId,
    domain: p.domain,
    nonce: p.nonce,
    uri: p.uri,
    version: "1",
    statement: SIGN_IN_STATEMENT,
    issuedAt: p.issuedAt ?? new Date(),
  });
}

// Sessions live in memory only: a reload asks for a new signature.
const sessions = new Map<string, AlertSession>();
const listeners = new Set<() => void>();
const sessionKey = (owner: string) => `${apiBaseUrl()}|${owner.toLowerCase()}`;
const notify = () => listeners.forEach((listener) => listener());

export async function signInForAlerts(p: {
  address: Address;
  chainId: number;
  sign: (message: string) => Promise<Hex>;
  domain?: string;
  uri?: string;
}): Promise<AlertSession> {
  const { nonce } = await requestAlertNonce(p.address);
  const message = buildSignInMessage({
    address: p.address,
    chainId: p.chainId,
    nonce,
    domain: p.domain ?? window.location.host,
    uri: p.uri ?? window.location.origin,
  });
  const signature = await p.sign(message);
  const verified = await verifyAlertSignIn(message, signature);
  const session: AlertSession = { owner: verified.owner.toLowerCase(), token: verified.token, expiresAt: verified.expiresAt };
  sessions.set(sessionKey(session.owner), session);
  notify();
  return session;
}

/** The owner's session while it is valid, for any letter case of the address. */
export function alertSession(owner: string, now = Date.now()): AlertSession | null {
  const session = sessions.get(sessionKey(owner));
  return session && now < session.expiresAt ? session : null;
}

export function clearAlertSession(owner: string): void {
  if (sessions.delete(sessionKey(owner))) notify();
}

/** An alert call answered 401: the session is gone. */
export function isSessionRejected(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Re-renders when a session is stored or cleared, and when the current one reaches its expiry. */
export function useAlertSession(owner: string | null): AlertSession | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const session = owner ? alertSession(owner) : null;
  const expiresAt = session?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const id = setTimeout(() => setVersion((v) => v + 1), Math.max(0, expiresAt - Date.now()) + 50);
    return () => clearTimeout(id);
  }, [expiresAt]);
  return session;
}

const WEBHOOK_ERROR = "Enter an https:// URL";

/** The backend's rule: https to a host, or http://localhost (development only); at most 2,048 characters. */
export function webhookInputError(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (text.length > 2_048) return WEBHOOK_ERROR;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return WEBHOOK_ERROR;
  }
  if (url.protocol === "https:" && url.hostname !== "") return null;
  if (url.protocol === "http:" && url.hostname === "localhost") return null;
  return WEBHOOK_ERROR;
}

export function formatMaskedWebhook(webhook: { host: string; last4: string }): string {
  return `${webhook.host} …${webhook.last4}`;
}
