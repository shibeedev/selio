import type { SelioChain } from "@selio/mcp";
import { createMcpHttpHandler } from "./adapters/mcp.adapter.js";
import { createMcpController } from "./mcp.controller.js";
import { createMcpRouter } from "./mcp.routes.js";

export function createMcpModule({ chain, maxReadsPerRequest }: { chain: SelioChain; maxReadsPerRequest?: number }) {
  return { router: createMcpRouter(createMcpController(createMcpHttpHandler(chain, maxReadsPerRequest))) };
}

export type { McpHttpHandler } from "./adapters/mcp.adapter.js";
