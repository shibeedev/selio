import type { IncomingMessage, ServerResponse } from "node:http";
import { handleStreamableHttpRequest, type SelioChain } from "@selio/mcp";

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;

/** Stateless Streamable HTTP: a fresh MCP server per request, sharing one chain layer, a per-request read bound and the event index URL. */
export function createMcpHttpHandler(chain: SelioChain, maxReadsPerRequest?: number, indexerUrl?: string): McpHttpHandler {
  return (req, res, body) => handleStreamableHttpRequest(req, res, body, { chain, maxReadsPerRequest, indexerUrl });
}
