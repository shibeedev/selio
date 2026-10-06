import { NETWORKS } from "@selio/sdk";
import { createTransactional, type Db } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { createAuthController } from "./auth.controller.js";
import { AuthRepository } from "./auth.repository.js";
import { createAuthRouter } from "./auth.routes.js";
import { AuthService } from "./auth.service.js";

export function createAuthModule({
  db,
  logger,
  allowedDomains,
  now,
}: {
  db: Db;
  logger: Logger;
  allowedDomains: "*" | string[];
  now?: () => number;
}) {
  const chainIds = [...new Set(Object.values(NETWORKS).map((n) => n.chain.id))];
  const service = new AuthService(new AuthRepository(db), createTransactional(db), logger.child({ module: "auth" }), {
    allowedDomains,
    chainIds,
    now,
  });
  return { service, router: createAuthRouter(createAuthController(service)) };
}

export { requireSession, sessionOwner } from "./auth.middleware.js";
export { AuthService };
export type { AuthServiceOptions } from "./auth.service.js";
export type { SessionPort } from "./auth.types.js";
