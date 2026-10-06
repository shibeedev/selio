import { pingDatabase, type Db } from "../../shared/db/database.js";
import { createHealthController } from "./health.controller.js";
import { createHealthRouter } from "./health.routes.js";
import { HealthService } from "./health.service.js";

export function createHealthModule({ db }: { db: Db }) {
  const service = new HealthService(() => pingDatabase(db));
  return { service, router: createHealthRouter(createHealthController(service)) };
}

export { HealthService };
