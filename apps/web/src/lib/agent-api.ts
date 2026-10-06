// Client of the exit agent service (apps/agent). Every /agent/v1/* call carries the user's Dynamic JWT.

export type GrantKind = "sell" | "bid" | "vault";

export interface GrantDto {
  id: string;
  network: "monad-testnet";
  kind: GrantKind;
  thresholdBps: number;
  alertId: string;
  /** Underlying base units, decimal strings. */
  maxPerAction: string;
  maxTotal: string;
  usedTotal: string;
  maxSellDiscountBps: number | null;
  payMask: number | null;
  minBidDiscountBps: number | null;
  payIdx: number | null;
  expiresAt: number;
  status: "active" | "revoked" | "expired" | "exhausted";
  createdAt: number;
}

export interface ActionDto {
  id: number;
  grantId: string;
  kind: GrantKind | "cancel";
  triggerAt: number;
  utilizationBps: number | null;
  /** Underlying base units; fee and net for sells only. */
  assets: string | null;
  fee: string | null;
  net: string | null;
  status: "planned" | "sending" | "done" | "failed" | "skipped";
  txHashes: string[];
  bidId: string | null;
  message: string | null;
  at: number;
}

export interface MeDto {
  address: string;
  delegation: { status: "active" | "revoked" | "invalid"; since: number } | null;
  /** Newest first, every status. */
  grants: GrantDto[];
  /** Newest first, at most 100. */
  actions: ActionDto[];
}

interface GrantBodyBase {
  id: string;
  network: "monad-testnet";
  alertId: string;
  thresholdBps: number;
  maxPerAction: string;
  maxTotal: string;
  expiresAt: number;
}

/** The body of POST /agent/v1/grants: each kind carries only its own fields. */
export type CreateGrantBody =
  | (GrantBodyBase & { kind: "sell"; maxSellDiscountBps: number; payMask?: number })
  | (GrantBodyBase & { kind: "bid"; minBidDiscountBps: number; payIdx: number })
  | (GrantBodyBase & { kind: "vault" });

/** A failed agent call; `message` is the text the panel shows. */
export class AgentApiError extends Error {
  constructor(
    message: string,
    /** The service's error code, or OFFLINE when it could not be reached. */
    readonly code: string,
    /** HTTP status; null when offline. */
    readonly status: number | null,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "AgentApiError";
  }

  get offline(): boolean {
    return this.status === null;
  }
}

export const SIGN_IN_AGAIN = "Your email or passkey sign-in has expired. Sign in again to manage the exit agent.";
export const AGENT_NOT_CONFIGURED = "The exit agent is not configured on this deployment yet.";

const FIELD_NAMES: Record<string, string> = {
  thresholdBps: "Threshold",
  maxPerAction: "Per-action maximum",
  maxTotal: "Total budget",
  expiresAt: "Expiry",
  maxSellDiscountBps: "Highest discount",
  payMask: "Pay tokens",
  minBidDiscountBps: "Lowest discount",
  payIdx: "Pay token",
};

/** Turns a non-2xx answer (`{ code, message, details? }`) into the error the panel shows. */
export function agentErrorFrom(status: number, body: unknown, retryAfter: string | null = null): AgentApiError {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof b.code === "string" ? b.code : `HTTP_${status}`;
  const serverMessage = typeof b.message === "string" && b.message ? b.message : null;
  const details = Array.isArray(b.details)
    ? b.details.flatMap((d) =>
        d && typeof d === "object" && typeof (d as Record<string, unknown>).message === "string"
          ? [{ path: String((d as Record<string, unknown>).path ?? ""), message: String((d as Record<string, unknown>).message) }]
          : [],
      )
    : [];
  let message: string;
  if (status === 401) message = SIGN_IN_AGAIN;
  else if (status === 429) {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
    message =
      seconds !== null
        ? `The exit agent is limiting requests; try again in ${seconds} s.`
        : "The exit agent is limiting requests; try again shortly.";
  } else if (code === "DYNAMIC_NOT_CONFIGURED") message = AGENT_NOT_CONFIGURED;
  else if (code === "VALIDATION_ERROR" && details.length > 0) {
    message = details.map((d) => `${FIELD_NAMES[d.path] ?? (d.path || "Request")}: ${d.message}`).join("; ");
  } else message = serverMessage ?? `The exit agent answered ${status}.`;
  return new AgentApiError(message, code, status, details);
}

export interface AgentApi {
  readonly baseUrl: string;
  me(token: string): Promise<MeDto>;
  createGrant(token: string, body: CreateGrantBody): Promise<{ id: string }>;
  deleteGrant(token: string, id: string, cancelBid: boolean): Promise<void>;
  revoke(token: string): Promise<{ revoked: true; dynamicRevoked: boolean }>;
}

const TIMEOUT_MS = 15_000;

export function createAgentApi(baseUrl: string, fetchImpl: typeof fetch = (...args) => fetch(...args)): AgentApi {
  const base = baseUrl.replace(/\/+$/, "");

  async function call(path: string, token: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch {
      throw new AgentApiError(`The exit agent is unreachable at ${base}.`, "OFFLINE", null);
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    if (res.status !== 204) {
      try {
        body = await res.json();
      } catch {
        // Empty or non-JSON body.
      }
    }
    if (!res.ok) throw agentErrorFrom(res.status, body, res.headers.get("retry-after"));
    return body;
  }

  return {
    baseUrl: base,
    me: async (token) => (await call("/agent/v1/me", token, { method: "GET" })) as MeDto,
    createGrant: async (token, body) => (await call("/agent/v1/grants", token, { method: "POST", body })) as { id: string },
    deleteGrant: async (token, id, cancelBid) => {
      await call(`/agent/v1/grants/${encodeURIComponent(id)}?cancelBid=${cancelBid}`, token, { method: "DELETE" });
    },
    revoke: async (token) =>
      (await call("/agent/v1/revoke", token, { method: "POST" })) as { revoked: true; dynamicRevoked: boolean },
  };
}
