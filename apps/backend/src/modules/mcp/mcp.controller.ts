import { AppError } from "../../shared/errors/AppError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { McpHttpHandler } from "./adapters/mcp.adapter.js";

export function createMcpController(handle: McpHttpHandler) {
  return {
    post: asyncHandler(async (req, res) => {
      await handle(req, res, req.body);
    }),
    // Stateless mode has no server-initiated stream or session to delete; 405 tells MCP clients so.
    notAllowed: asyncHandler(async (_req, res) => {
      res.setHeader("Allow", "POST");
      throw new AppError(405, "METHOD_NOT_ALLOWED", "This MCP endpoint is stateless; send JSON-RPC requests with POST");
    }),
  };
}

export type McpController = ReturnType<typeof createMcpController>;
