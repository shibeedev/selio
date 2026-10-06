import { apiBaseUrl } from "./env";

/** `offline`: the backend could not be reached. `status`: the HTTP status of a non-OK answer. */
export class ApiError extends Error {
  readonly offline: boolean;
  readonly status: number | null;
  constructor(message: string, offline: boolean, status: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.offline = offline;
    this.status = status;
  }
}

export interface HistoryPoint {
  t: number;
  utilizationBps: number;
  withdrawable: string;
  supplied: string;
}

export interface AlertRule {
  id: string;
  network: string;
  thresholdBps: number;
  /** The backend never returns a saved webhook URL in full. */
  webhook: { host: string; last4: string } | null;
}

export interface AlertNonce {
  nonce: string;
  expiresAt: number;
}

export interface AlertSignIn {
  token: string;
  owner: string;
  expiresAt: number;
}

export interface AlertEvent {
  network: string;
  utilizationBps: number;
  thresholdBps: number;
  at: number;
}

export type FaucetKit = "seller" | "borrower" | "bidder";

type Body = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const str = (v: unknown): string => String(v ?? "");
const list = (v: unknown): Body[] =>
  Array.isArray(v) ? v.filter((item): item is Body => typeof item === "object" && item !== null) : [];
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * The backend waits up to 60 s for a running kit on the same fork and then runs its own kit (120 s for a
 * first seller kit on a cold fork), so the faucet call gets more than both before it gives up.
 */
export const FAUCET_TIMEOUT_MS = 200_000;

interface RequestOptions {
  timeoutMs?: number;
  /** Reported when the timeout fires, instead of calling the backend unreachable. */
  timeoutMessage?: string;
}

async function request(path: string, init: RequestInit = {}, opts: RequestOptions = {}): Promise<Body> {
  const base = apiBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted && opts.timeoutMessage) throw new ApiError(opts.timeoutMessage, false);
    throw new ApiError(`The Selio backend is unreachable at ${base}.`, true);
  } finally {
    clearTimeout(timer);
  }
  let body: Body = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Body;
  } catch {
    // Empty or non-JSON body.
  }
  if (!res.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : `The backend answered ${res.status}.`;
    throw new ApiError(message, false, res.status);
  }
  return body;
}

export async function getCapacityHistory(network: string, hours = 24): Promise<HistoryPoint[]> {
  const body = await request(`/api/capacity/${encodeURIComponent(network)}/history?hours=${hours}`);
  return list(body.points)
    .map((p) => ({
      t: num(p.t),
      utilizationBps: num(p.utilizationBps),
      withdrawable: str(p.withdrawable),
      supplied: str(p.supplied),
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.utilizationBps));
}

export async function requestAlertNonce(address: string): Promise<AlertNonce> {
  const body = await request("/api/auth/nonce", { method: "POST", body: JSON.stringify({ address }) });
  return { nonce: str(body.nonce), expiresAt: num(body.expiresAt) };
}

export async function verifyAlertSignIn(message: string, signature: string): Promise<AlertSignIn> {
  const body = await request("/api/auth/verify", { method: "POST", body: JSON.stringify({ message, signature }) });
  return { token: str(body.token), owner: str(body.owner), expiresAt: num(body.expiresAt) };
}

export async function createAlert(
  input: { network: string; thresholdBps: number; webhookUrl?: string; owner: string },
  token: string,
): Promise<string> {
  const body = await request("/api/alerts", { method: "POST", body: JSON.stringify(input), headers: bearer(token) });
  return str(body.id);
}

export async function listAlerts(owner: string, token: string): Promise<AlertRule[]> {
  const body = await request(`/api/alerts?owner=${encodeURIComponent(owner)}`, { headers: bearer(token) });
  return list(body.alerts).map((a) => {
    const w = a.webhook as Body | null | undefined;
    const webhook =
      w && typeof w === "object" && typeof w.host === "string" && typeof w.last4 === "string"
        ? { host: w.host, last4: w.last4 }
        : null;
    return { id: str(a.id), network: str(a.network), thresholdBps: num(a.thresholdBps), webhook };
  });
}

export async function deleteAlert(id: string, owner: string, token: string): Promise<void> {
  await request(`/api/alerts/${encodeURIComponent(id)}?owner=${encodeURIComponent(owner)}`, {
    method: "DELETE",
    headers: bearer(token),
  });
}

export async function getAlertEvents(owner: string, token: string): Promise<AlertEvent[]> {
  const body = await request(`/api/alerts/events?owner=${encodeURIComponent(owner)}`, { headers: bearer(token) });
  return list(body.events).map((e) => ({
    network: str(e.network),
    utilizationBps: num(e.utilizationBps),
    thresholdBps: num(e.thresholdBps),
    at: num(e.at),
  }));
}

/** Runs a demo kit on a fork; returns the backend's description of each step it took. */
export async function requestDemoFunds(network: string, address: string, kit: FaucetKit): Promise<string[]> {
  const body = await request(
    "/api/faucet",
    { method: "POST", body: JSON.stringify({ network, address, kit }) },
    {
      timeoutMs: FAUCET_TIMEOUT_MS,
      // The UI test reads /fail|error|limit/i as a failed kit, and this one is still running.
      timeoutMessage: "The kit is still running on the fork. Check your balances in a minute instead of asking again.",
    },
  );
  if (body.ok !== true) throw new ApiError("The faucet did not confirm the transfer.", false);
  return Array.isArray(body.actions) ? body.actions.map(String) : [];
}
