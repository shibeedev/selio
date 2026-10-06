import { createTransactional, type Db } from "../../shared/db/database.js";
import type { RateLimitPort } from "../../shared/db/rateLimits.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { requireSession, type SessionPort } from "../auth/index.js";
import { WebhookAdapter } from "./adapters/webhook.adapter.js";
import { createAlertsController } from "./alerts.controller.js";
import { AlertRepository } from "./alerts.repository.js";
import { createAlertsRouter } from "./alerts.routes.js";
import { AlertService } from "./alerts.service.js";
import type { WebhookSender } from "./alerts.types.js";

export function createAlertsModule({
  db,
  logger,
  sessions,
  limits,
  webhookSecret,
  webhook,
  allowLocalhostWebhooks = false,
  now,
}: {
  db: Db;
  logger: Logger;
  sessions: SessionPort;
  limits: RateLimitPort;
  webhookSecret?: string;
  webhook?: WebhookSender;
  allowLocalhostWebhooks?: boolean;
  now?: () => number;
}) {
  const sender = webhook ?? new WebhookAdapter({ secret: webhookSecret, allowLocalhost: allowLocalhostWebhooks });
  const service = new AlertService(
    new AlertRepository(db),
    sender,
    createTransactional(db),
    logger.child({ module: "alerts" }),
    now,
    undefined,
    { limits },
  );
  return { service, router: createAlertsRouter(createAlertsController(service), requireSession(sessions)) };
}

export { AlertService, shouldFire, maskWebhook } from "./alerts.service.js";
export type { AlertServiceOptions } from "./alerts.service.js";
export type { WebhookPayload, WebhookSender, WebhookTarget } from "./alerts.types.js";
