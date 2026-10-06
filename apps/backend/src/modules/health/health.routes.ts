import { Router } from "express";
import type { HealthController } from "./health.controller.js";

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  router.get("/healthz", controller.liveness);
  router.get("/readyz", controller.readiness);
  return router;
}
