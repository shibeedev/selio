import { NETWORKS } from "@selio/sdk";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import { NETWORK_KEYS } from "../../shared/utils/validation.js";
import type { NetworkSummary } from "./networks.types.js";

export type NetworksChainPort = Pick<ChainGateway, "deployment" | "isReachable">;

export class NetworksService {
  constructor(private readonly chain: NetworksChainPort) {}

  /** Every network, deployed or not, in registry order; the reachability probes run in parallel. */
  getNetworks(): Promise<NetworkSummary[]> {
    return Promise.all(
      NETWORK_KEYS.map(async (key) => {
        const info = NETWORKS[key];
        const deployment = this.chain.deployment(key);
        return {
          key,
          label: info.label,
          description: info.description,
          venue: info.venue,
          isFork: info.isFork,
          chainId: deployment?.chainId ?? info.chain.id,
          explorerUrl: info.explorerUrl ?? null,
          deploymentLoaded: deployment !== null,
          market: deployment?.market ?? null,
          rpcReachable: await this.chain.isReachable(key),
        };
      }),
    );
  }
}
