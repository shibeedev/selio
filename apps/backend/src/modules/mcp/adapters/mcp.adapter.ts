import type { IncomingMessage, ServerResponse } from "node:http";
import { handleStreamableHttpRequest, type SelioChain } from "@selio/mcp";

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;

/** Stateless Streamable HTTP: a fresh MCP server per request, sharing one chain layer and a per-request read bound. */
export function createMcpHttpHandler(chain: SelioChain, maxReadsPerRequest?: number): McpHttpHandler {
  return (req, res, body) => handleStreamableHttpRequest(req, res, body, { chain, maxReadsPerRequest });
}
