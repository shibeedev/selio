import { Router } from "express";
import type { CapacityController } from "./capacity.controller.js";

export function createCapacityRouter(controller: CapacityController): Router {
  const router = Router();
  router.get("/api/capacity/:network", controller.getCapacity);
  router.get("/api/capacity/:network/history", controller.getHistory);
  return router;
}
