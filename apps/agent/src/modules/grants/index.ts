import type { Transactional } from "../../shared/db/database.js";
import type { DynamicPort } from "../../shared/integrations/dynamic/dynamic.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { requireDynamicUser, type TokenVerifier } from "../../shared/middlewares/requireDynamicUser.js";
import type { DelegationPort } from "../delegations/index.js";
import type { ActionRepository } from "../executor/actions.repository.js";
import { createGrantsController } from "./grants.controller.js";
import type { GrantRepository } from "./grants.repository.js";
import { createGrantsRouter } from "./grants.routes.js";
import { GrantService, type GrantServiceOptions } from "./grants.service.js";

export { GrantRepository } from "./grants.repository.js";
export { GrantService } from "./grants.service.js";
export type { GrantKind, GrantRow, GrantStatus } from "./grants.model.js";
export type { ActionDto, GrantDto, MeDto } from "./grants.types.js";

export interface GrantsModuleDeps {
  grants: GrantRepository;
  actions: ActionRepository;
  delegations: DelegationPort;
  executor: { enqueue(actionId: number): void };
  dynamic: Pick<DynamicPort, "revokeDelegatedAccess"> | null;
  /** null while Dynamic is not configured: every route answers 503. */
  verifyToken: TokenVerifier | null;
  payTokenCount: () => number;
  inTransaction: Transactional;
  logger: Logger;
  options: GrantServiceOptions;
  now?: () => number;
}

export function createGrantsModule(deps: GrantsModuleDeps) {
  const service = new GrantService(
    deps.grants,
    deps.actions,
    deps.delegations,
    deps.executor,
    deps.dynamic,
    deps.payTokenCount,
    deps.inTransaction,
    deps.logger.child({ module: "grants" }),
    deps.options,
    deps.now,
  );
  return { service, router: createGrantsRouter(createGrantsController(service), requireDynamicUser(deps.verifyToken)) };
}
