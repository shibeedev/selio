import type { Deployment } from "@selio/sdk";
import { AppError } from "../../shared/errors/AppError.js";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import { NETWORK_KEYS } from "../../shared/utils/validation.js";

export type DeploymentsChainPort = Pick<ChainGateway, "deployment">;

/** `<network key>.json`. The name only selects a network; it never becomes a path. */
const FILE_NAME = /^[a-z0-9-]+\.json$/;

export class DeploymentsService {
  constructor(private readonly chain: DeploymentsChainPort) {}

  /**
   * The deployment that the chain gateway resolves for the network `file` names. Any other name, a missing or
   * unparseable file and a file for another network all get the same 404, which names no path.
   */
  getDeployment(file: string): Deployment {
    const key = file.replace(/\.json$/, "");
    const network = FILE_NAME.test(file) ? NETWORK_KEYS.find((k) => k === key) : undefined;
    const deployment = network ? this.chain.deployment(network) : null;
    if (!deployment) throw new AppError(404, "NOT_FOUND", `No deployment for ${key}`);
    return deployment;
  }
}
