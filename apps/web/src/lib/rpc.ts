import { http, type HttpTransport } from "viem";
import type { NetworkKey } from "@selio/sdk";

/** The JSON-RPC error code Monad's public RPC answers with above its per-IP request rate; viem does not retry it. */
export const RATE_LIMIT_CODE = -32011;
/** A rate-limited request is retried this many times, after 250, 500, 1,000 and 2,000 ms unless the RPC says when. */
export const RATE_LIMIT_RETRIES = 4;
export const RATE_LIMIT_DELAY_MS = 250;

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number, signal?: AbortSignal | null) => Promise<void>;

/** Waits `ms`, or rejects as soon as the request is aborted (viem aborts it at its timeout). */
const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The wait a response's Retry-After header asks for (seconds or an HTTP date), or null without one. */
function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Whether the RPC turned the request away for its rate limit: HTTP 429, or JSON-RPC error -32011 in any answer. */
async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  if (!text.includes(String(RATE_LIMIT_CODE))) return false;
  try {
    const body: unknown = JSON.parse(text);
    return (Array.isArray(body) ? body : [body]).some(
      (answer) => (answer as { error?: { code?: unknown } } | null)?.error?.code === RATE_LIMIT_CODE,
    );
  } catch {
    return false;
  }
}

/**
 * `fetchFn`, retrying requests the RPC turned away for its rate limit with exponential backoff, or after the wait its
 * Retry-After header asks for. The last answer goes back to viem as it came.
 */
export function retryRateLimited(fetchFn: FetchFn = (input, init) => fetch(input, init), wait: Sleep = sleep): FetchFn {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchFn(input, init);
      if (attempt === RATE_LIMIT_RETRIES || !(await isRateLimited(response))) return response;
      await response.body?.cancel().catch(() => undefined);
      await wait(retryAfterMs(response) ?? RATE_LIMIT_DELAY_MS * 2 ** attempt, init?.signal);
    }
  };
}

/** The HTTP transport of a network's RPC. Monad testnet's public RPC rate-limits per IP, so its requests retry. */
export function rpcTransport(key: NetworkKey, url: string): HttpTransport {
  return key === "monad-testnet" ? http(url, { fetchFn: retryRateLimited() }) : http(url);
}
