import express, { Router } from "express";
import type { DelegationsController } from "./delegations.controller.js";

export function createDelegationsRouter(controller: DelegationsController): Router {
  const router = Router();
  // Raw bytes: the signature is computed over the exact body received.
  router.post("/dynamic/webhooks", express.raw({ type: "application/json", limit: "1mb" }), controller.receive);
  return router;
}
