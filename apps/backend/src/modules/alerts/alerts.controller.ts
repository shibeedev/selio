import type { Response } from "express";
import { AppError } from "../../shared/errors/AppError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { sessionOwner } from "../auth/index.js";
import { alertIdParamsSchema, createAlertSchema, ownerQuerySchema } from "./alerts.schema.js";
import type { AlertService } from "./alerts.service.js";

/** Alerts belong to the address that signed in; any other `owner` is refused. */
function assertSessionOwner(res: Response, owner: string): void {
  const signedIn = sessionOwner(res);
  if (owner !== signedIn) throw new AppError(403, "FORBIDDEN", `Signed in as ${signedIn}, not ${owner}`);
}

export function createAlertsController(service: AlertService) {
  return {
    createAlert: asyncHandler(async (req, res) => {
      const input = createAlertSchema.parse(req.body);
      assertSessionOwner(res, input.owner);
      const alert = await service.createAlert(input);
      res.status(201).json({ id: alert.id });
    }),
    getAlerts: asyncHandler(async (req, res) => {
      const { owner } = ownerQuerySchema.parse(req.query);
      assertSessionOwner(res, owner);
      res.json({ alerts: service.getAlerts(owner) });
    }),
    getEvents: asyncHandler(async (req, res) => {
      const { owner } = ownerQuerySchema.parse(req.query);
      assertSessionOwner(res, owner);
      res.json({ events: service.getEvents(owner) });
    }),
    deleteAlert: asyncHandler(async (req, res) => {
      const { id } = alertIdParamsSchema.parse(req.params);
      const body: unknown = req.body;
      const bodyOwner = typeof body === "object" && body !== null ? (body as { owner?: unknown }).owner : undefined;
      const { owner } = ownerQuerySchema.parse({ owner: req.query.owner ?? bodyOwner });
      assertSessionOwner(res, owner);
      service.deleteAlert(id, owner);
      res.status(204).end();
    }),
  };
}

export type AlertsController = ReturnType<typeof createAlertsController>;
