import { Router } from "express";
import type { AuthController } from "./auth.controller.js";

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();
  router.post("/api/auth/nonce", controller.createNonce);
  router.post("/api/auth/verify", controller.verify);
  return router;
}
