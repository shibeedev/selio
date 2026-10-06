import { Router, type RequestHandler } from "express";
import type { AlertsController } from "./alerts.controller.js";

/** `session` (the auth module's `requireSession`) runs before each handler, so it comes before any validation. */
export function createAlertsRouter(controller: AlertsController, session: RequestHandler): Router {
  const router = Router();
  router.post("/api/alerts", session, controller.createAlert);
  router.get("/api/alerts", session, controller.getAlerts);
  router.get("/api/alerts/events", session, controller.getEvents);
  router.delete("/api/alerts/:id", session, controller.deleteAlert);
  return router;
}
