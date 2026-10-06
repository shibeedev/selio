import { createNetworksController } from "./networks.controller.js";
import { createNetworksRouter } from "./networks.routes.js";
import { NetworksService, type NetworksChainPort } from "./networks.service.js";

export function createNetworksModule({ chain }: { chain: NetworksChainPort }) {
  const service = new NetworksService(chain);
  return { service, router: createNetworksRouter(createNetworksController(service)) };
}

export { NetworksService };
export type { NetworksChainPort };
export type { NetworkSummary } from "./networks.types.js";
