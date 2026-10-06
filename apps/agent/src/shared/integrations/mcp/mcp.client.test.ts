import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "../../errors/AppError.js";
import { McpClient, McpToolError } from "./mcp.client.js";

// A stateless MCP endpoint hosted like the backend's POST /mcp: a fresh server and transport per request.
function selioLikeServer() {
  const server = new McpServer({ name: "selio", version: "0.1.0" });
  server.registerTool(
    "get_exit_capacity",
    { description: "Live exit capacity", inputSchema: { network: z.enum(["monad-testnet", "usdt0-replay", "vault-freeze"]) } },
    async ({ network }) => ({
      content: [{ type: "text", text: JSON.stringify({ network, utilization: { bps: 9_950, percent: "99.50%" } }, null, 2) }],
    }),
  );
  server.registerTool("build_sell_now", { description: "Build a sale", inputSchema: { network: z.string() } }, async () => ({
    isError: true,
    content: [{ type: "text", text: "No escrowed bid buys at or below 3.00% in USDC." }],
  }));
  return server;
}

let http: Server;
let url: string;
let posts = 0;

beforeAll(async () => {
  http = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    posts++;
    const server = selioLikeServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("McpClient", () => {
  it("connects once and returns each tool's parsed JSON text", async () => {
    const client = new McpClient(url);
    expect(await client.callTool("get_exit_capacity", { network: "monad-testnet" })).toEqual({
      network: "monad-testnet",
      utilization: { bps: 9_950, percent: "99.50%" },
    });
    const before = posts;
    await client.callTool("get_exit_capacity", { network: "vault-freeze" });
    expect(posts - before).toBe(1);
    await client.close();
  });

  it("turns an isError result into McpToolError with the tool's text", async () => {
    const client = new McpClient(url);
    const err = await client.callTool("build_sell_now", { network: "monad-testnet" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toBe("No escrowed bid buys at or below 3.00% in USDC.");
    const invalid = await client.callTool("get_exit_capacity", { network: "ethereum" }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(McpToolError);
    expect((invalid as Error).message).toContain("Input validation error");
    await client.close();
  });

  it("reports an unreachable endpoint as an upstream error", async () => {
    const client = new McpClient("http://127.0.0.1:9/mcp");
    const err = await client.callTool("get_exit_capacity", { network: "monad-testnet" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 502, code: "UPSTREAM_ERROR" });
    expect((err as Error).message).toMatch(/^MCP server is not reachable/);
  });
});
