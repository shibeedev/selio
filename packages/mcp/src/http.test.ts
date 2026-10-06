import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleStreamableHttpRequest, type SelioMcpOptions } from "./server.js";
import { AAVE_DEPLOYMENT } from "./testing/fakes.js";
import { listen, startRpcStub } from "./testing/rpc-stub.js";

const LIMIT = /^This request needs more than \d+ chain reads, the limit of this MCP endpoint\./;

let deploymentsDir: string;

beforeAll(() => {
  deploymentsDir = mkdtempSync(join(tmpdir(), "selio-mcp-http-"));
  writeFileSync(join(deploymentsDir, "usdt0-replay.json"), JSON.stringify(AAVE_DEPLOYMENT));
});

afterAll(() => rmSync(deploymentsDir, { recursive: true, force: true }));

/** Serves POST /mcp like the backend: the JSON body is parsed first, then handed over. */
async function withEndpoint<T>(options: SelioMcpOptions, fn: (url: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      void handleStreamableHttpRequest(req, res, raw ? JSON.parse(raw) : undefined, options);
    });
  });
  const endpoint = await listen(server);
  try {
    return await fn(`${endpoint.url}/mcp`);
  } finally {
    await endpoint.close();
  }
}

/** A JSON-RPC node and MCP options that read from it; each request gets a fresh chain layer and token cache. */
async function withChain<T>(maxReadsPerRequest: number | undefined, fn: (url: string, reads: () => number) => Promise<T>) {
  const rpc = await startRpcStub();
  try {
    const options: SelioMcpOptions = { deploymentsDir, rpcUrls: { "usdt0-replay": rpc.url }, maxReadsPerRequest };
    return await withEndpoint(options, (url) => fn(url, rpc.requests));
  } finally {
    await rpc.close();
  }
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const capacityCall = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "get_exit_capacity", arguments: { network: "usdt0-replay" } },
});

interface ToolReply {
  id: number;
  result: { isError?: boolean; content: { text: string }[] };
}

describe("Streamable HTTP", () => {
  it("answers initialize and a separate tools/list without a session", async () => {
    await withChain(undefined, async (url) => {
      const init = await post(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "selio-test", version: "0.0.0" } },
      });
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBeNull();
      expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("selio");
      const list = await post(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(list.status).toBe(200);
      const { result } = (await list.json()) as { result: { tools: { name: string }[] } };
      const names = result.tools.map((t) => t.name);
      expect(names).toHaveLength(19);
      expect(names).toContain("build_buy_and_repay");
      expect(names).toContain("simulate_transaction");
      expect(names.at(-1)).toBe("get_history");
    });
  });

  it("answers GET and DELETE with 405 and Allow: POST", async () => {
    await withChain(undefined, async (url) => {
      for (const method of ["GET", "DELETE"]) {
        const res = await fetch(url, { method, headers: { accept: "application/json, text/event-stream" } });
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("POST");
        expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/stateless/);
      }
    });
  });

  it("serves a tool call that stays within the read bound", async () => {
    await withChain(8, async (url, reads) => {
      const reply = (await (await post(url, capacityCall(1))).json()) as ToolReply;
      expect(reply.result.isError).toBeFalsy();
      expect(JSON.parse(reply.result.content[0]!.text).utilization.percent).toBe("100.00%");
      // capacity(), symbol(), decimals() and bidCapacityAt at five levels.
      expect(reads()).toBe(8);
    });
  });

  it("refuses a tool call that needs more chain reads than the bound", async () => {
    await withChain(7, async (url, reads) => {
      const reply = (await (await post(url, capacityCall(1))).json()) as ToolReply;
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0]!.text).toMatch(LIMIT);
      expect(reply.result.content[0]!.text).toContain("more than 7 chain reads");
      expect(reads()).toBeLessThanOrEqual(7);
    });
  });

  it("shares one bound across the tool calls of a batch, and starts afresh with each request", async () => {
    await withChain(10, async (url, reads) => {
      const replies = (await (await post(url, [capacityCall(1), capacityCall(2)])).json()) as ToolReply[];
      expect(replies).toHaveLength(2);
      const refused = replies.filter((r) => r.result.isError);
      expect(refused.length).toBeGreaterThan(0);
      for (const r of refused) expect(r.result.content[0]!.text).toMatch(LIMIT);
      expect(reads()).toBeLessThanOrEqual(10);
      const single = (await (await post(url, capacityCall(3))).json()) as ToolReply;
      expect(single.result.isError).toBeFalsy();
    });
  });

  it("does not count reads without a bound", async () => {
    await withChain(undefined, async (url) => {
      const replies = (await (await post(url, [capacityCall(1), capacityCall(2)])).json()) as ToolReply[];
      expect(replies.map((r) => r.result.isError ?? false)).toEqual([false, false]);
    });
  });
});
