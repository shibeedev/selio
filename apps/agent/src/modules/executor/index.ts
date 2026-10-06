import type { Transactional } from "../../shared/db/database.js";
import type { ChainPort } from "../../shared/integrations/chain/chain.gateway.js";
import type { DynamicPort } from "../../shared/integrations/dynamic/dynamic.gateway.js";
import type { McpPort } from "../../shared/integrations/mcp/mcp.client.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { DelegationPort } from "../delegations/index.js";
import type { GrantRepository } from "../grants/index.js";
import type { ActionRepository } from "./actions.repository.js";
import { ExecutorService, type ExecutorOptions } from "./executor.service.js";
import type { IntentRepository } from "./intents.repository.js";

export { ActionRepository } from "./actions.repository.js";
export { IntentRepository } from "./intents.repository.js";
export { ExecutorService } from "./executor.service.js";
export { MESSAGES } from "./executor.types.js";
export type { ActionKind, ActionRow, ActionStatus } from "./actions.repository.js";
export type { ExecutorOptions } from "./executor.service.js";

export interface ExecutorModuleDeps {
  actions: ActionRepository;
  intents: IntentRepository;
  grants: GrantRepository;
  delegations: DelegationPort;
  chain: ChainPort;
  mcp: McpPort;
  dynamic: Pick<DynamicPort, "signTransaction"> | null;
  inTransaction: Transactional;
  logger: Logger;
  options: ExecutorOptions;
  now?: () => number;
}

export function createExecutorModule(deps: ExecutorModuleDeps) {
  const service = new ExecutorService(
    deps.actions,
    deps.intents,
    deps.grants,
    deps.delegations,
    deps.chain,
    deps.mcp,
    deps.dynamic,
    deps.inTransaction,
    deps.logger.child({ module: "executor" }),
    deps.options,
    deps.now,
  );
  return { service };
}
