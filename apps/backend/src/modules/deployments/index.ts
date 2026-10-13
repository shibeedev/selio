import { createDeploymentsController } from "./deployments.controller.js";
import { createDeploymentsRouter } from "./deployments.routes.js";
import { DeploymentsService, type DeploymentsChainPort } from "./deployments.service.js";

export function createDeploymentsModule({ chain }: { chain: DeploymentsChainPort }) {
  const service = new DeploymentsService(chain);
  return { service, router: createDeploymentsRouter(createDeploymentsController(service)) };
}

export { DeploymentsService };
export type { DeploymentsChainPort };
