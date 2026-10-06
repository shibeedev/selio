import type { Transactional } from "../../shared/db/database.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { ActionRepository } from "../executor/actions.repository.js";
import type { GrantRepository } from "../grants/grants.repository.js";
import { createTriggersController } from "./triggers.controller.js";
import { createTriggersRouter } from "./triggers.routes.js";
import { TriggerService, type TriggerServiceOptions } from "./triggers.service.js";

export { TriggerService } from "./triggers.service.js";
export { ALERT_TYPE } from "./triggers.schema.js";

export interface TriggersModuleDeps {
  grants: GrantRepository;
  actions: ActionRepository;
  executor: { enqueue(actionId: number): void };
  inTransaction: Transactional;
  logger: Logger;
  options: TriggerServiceOptions;
  now?: () => number;
}

export function createTriggersModule(deps: TriggersModuleDeps) {
  const service = new TriggerService(
    deps.grants,
    deps.actions,
    deps.executor,
    deps.inTransaction,
    deps.logger.child({ module: "triggers" }),
    deps.options,
    deps.now,
  );
  return { service, router: createTriggersRouter(createTriggersController(service)) };
}
