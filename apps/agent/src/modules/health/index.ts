import type { Db } from "../../shared/db/database.js";
import { createHealthController } from "./health.controller.js";
import { createHealthRouter } from "./health.routes.js";
import { HealthService } from "./health.service.js";

export function createHealthModule(deps: { db: Db; dynamicMissing: readonly string[] }) {
  const service = new HealthService(deps.db, deps.dynamicMissing);
  return { service, router: createHealthRouter(createHealthController(service)) };
}
