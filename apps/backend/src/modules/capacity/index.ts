import { createTransactional, type Db } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { createCapacityController } from "./capacity.controller.js";
import { CapacityPoller } from "./capacity.poller.js";
import { CapacityRepository } from "./capacity.repository.js";
import { createCapacityRouter } from "./capacity.routes.js";
import { CapacityService, type CapacityChainPort } from "./capacity.service.js";
import type { SnapshotListener } from "./capacity.types.js";

export function createCapacityModule({
  db,
  chain,
  logger,
  now,
}: {
  db: Db;
  chain: CapacityChainPort;
  logger: Logger;
  now?: () => number;
}) {
  const log = logger.child({ module: "capacity" });
  const service = new CapacityService(new CapacityRepository(db), chain, createTransactional(db), log, now);
  return {
    service,
    router: createCapacityRouter(createCapacityController(service)),
    createPoller: (intervalMs: number, listeners: SnapshotListener[]) =>
      new CapacityPoller(() => service.snapshotAll(), listeners, intervalMs, log),
  };
}

export { CapacityPoller, CapacityService };
export { toHistoryPoints } from "./capacity.service.js";
export type { CapacityChainPort };
export type { CapacitySnapshot, SnapshotListener } from "./capacity.types.js";
