import { describe, expect, it } from "vitest";
import { createPublicClient, http, RpcRequestError } from "viem";
import { RATE_LIMIT_CODE, retryRateLimited } from "./rpc";

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** An RPC that gives the queued answers in turn, then block number 42 to every request. */
function fakeRpc(answers: Answer[]) {
  let calls = 0;
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    const next = answers.shift() ?? { body: { jsonrpc: "2.0", id, result: "0x2a" } };
    const text = typeof next.body === "string";
    return new Response(text ? (next.body as string) : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": text ? "text/plain" : "application/json", ...next.headers },
    });
  };
  return { fetchFn, calls: () => calls };
}

const limited = (status = 200, headers?: Record<string, string>): Answer => ({
  status,
  headers,
  body: { jsonrpc: "2.0", id: 1, error: { code: RATE_LIMIT_CODE, message: "Too many requests" } },
});

/** A viem client on the fake RPC whose retry waits are recorded instead of slept. */
function clientOn(rpc: ReturnType<typeof fakeRpc>, waits: number[]) {
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  return createPublicClient({ transport: http("http://rpc.test", { fetchFn: retryRateLimited(rpc.fetchFn, wait) }) });
}

describe("rate-limited Monad testnet RPC", () => {
  it("retries -32011 and HTTP 429 with exponential backoff, or after the wait Retry-After asks for", async () => {
    const rpc = fakeRpc([limited(), limited(429, { "Retry-After": "2" }), { status: 429, body: "Too Many Requests" }]);
    const waits: number[] = [];
    expect(await clientOn(rpc, waits).getBlockNumber()).toBe(42n);
    expect(waits).toEqual([250, 2000, 1000]);
    expect(rpc.calls()).toBe(4);
  });

  it("gives up after 4 retries and leaves other errors alone", async () => {
    const rpc = fakeRpc(Array.from({ length: 5 }, () => limited()));
    const waits: number[] = [];
    const error = await clientOn(rpc, waits)
      .getBlockNumber()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcRequestError);
    expect((error as RpcRequestError).code).toBe(RATE_LIMIT_CODE);
    expect(waits).toEqual([250, 500, 1000, 2000]);
    expect(rpc.calls()).toBe(5);

    const failing = fakeRpc([{ body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } } }]);
    const none: number[] = [];
    await expect(clientOn(failing, none).getBlockNumber()).rejects.toThrow();
    expect(none).toEqual([]);
    expect(failing.calls()).toBe(1);
  });
});
