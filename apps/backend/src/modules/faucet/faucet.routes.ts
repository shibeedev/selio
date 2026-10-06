import { Router } from "express";
import type { FaucetController } from "./faucet.controller.js";

export function createFaucetRouter(controller: FaucetController): Router {
  const router = Router();
  router.post("/api/faucet", controller.requestKit);
  return router;
}
