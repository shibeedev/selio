import type { Transactional } from "../../shared/db/database.js";
import type { DynamicPort } from "../../shared/integrations/dynamic/dynamic.gateway.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import { createDelegationsController } from "./delegations.controller.js";
import type { DelegationRepository } from "./delegations.repository.js";
import { createDelegationsRouter } from "./delegations.routes.js";
import { DelegationService, type GrantRevoker } from "./delegations.service.js";

export { DelegationRepository } from "./delegations.repository.js";
export { DelegationService, WEBHOOK_EVENT_RETENTION_MS } from "./delegations.service.js";
export type { DelegationPort, DelegationServiceOptions, GrantRevoker } from "./delegations.service.js";
export type { DelegationRow, DelegationStatus } from "./delegations.model.js";

export interface DelegationsModuleDeps {
  repo: DelegationRepository;
  grants: GrantRevoker;
  inTransaction: Transactional;
  logger: Logger;
  storageKey: Buffer;
  /** null while Dynamic is not configured: the webhook route answers 503. */
  dynamic: { environmentId: string; webhookSecret: string; gateway: Pick<DynamicPort, "decryptDelegation"> } | null;
  pruneEveryMs?: number;
  now?: () => number;
}

export function createDelegationsModule(deps: DelegationsModuleDeps) {
  const service = new DelegationService(
    deps.repo,
    deps.grants,
    deps.dynamic?.gateway ?? null,
    deps.inTransaction,
    deps.logger.child({ module: "delegations" }),
    {
      storageKey: deps.storageKey,
      webhook: deps.dynamic ? { environmentId: deps.dynamic.environmentId, secret: deps.dynamic.webhookSecret } : null,
      ...(deps.pruneEveryMs !== undefined ? { pruneEveryMs: deps.pruneEveryMs } : {}),
    },
    deps.now,
  );
  return { service, router: createDelegationsRouter(createDelegationsController(service)) };
}
