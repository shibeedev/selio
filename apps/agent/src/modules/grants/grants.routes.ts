import { Router, type RequestHandler } from "express";
import type { GrantsController } from "./grants.controller.js";

export function createGrantsRouter(controller: GrantsController, requireUser: RequestHandler): Router {
  const router = Router();
  router.get("/agent/v1/me", requireUser, controller.me);
  router.post("/agent/v1/grants", requireUser, controller.create);
  router.delete("/agent/v1/grants/:id", requireUser, controller.remove);
  router.post("/agent/v1/revoke", requireUser, controller.revoke);
  return router;
}
