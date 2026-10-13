import { Router } from "express";
import type { DeploymentsController } from "./deployments.controller.js";

export function createDeploymentsRouter(controller: DeploymentsController): Router {
  const router = Router();
  router.get("/deployments/:file", controller.getDeployment);
  return router;
}
