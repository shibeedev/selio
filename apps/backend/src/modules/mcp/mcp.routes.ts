import { Router } from "express";
import type { McpController } from "./mcp.controller.js";

export function createMcpRouter(controller: McpController): Router {
  const router = Router();
  router.post("/mcp", controller.post);
  router.get("/mcp", controller.notAllowed);
  router.delete("/mcp", controller.notAllowed);
  return router;
}
