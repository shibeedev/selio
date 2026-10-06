import express, { Router } from "express";
import type { TriggersController } from "./triggers.controller.js";

export function createTriggersRouter(controller: TriggersController): Router {
  const router = Router();
  // Raw bytes: X-Selio-Signature is computed over the exact body received.
  router.post("/hooks/alert/:grantId", express.raw({ type: "application/json", limit: "1mb" }), controller.receive);
  return router;
}
