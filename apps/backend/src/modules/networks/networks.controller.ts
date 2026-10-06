import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { NetworksService } from "./networks.service.js";

export function createNetworksController(service: NetworksService) {
  return {
    getNetworks: asyncHandler(async (_req, res) => {
      res.json({ networks: await service.getNetworks() });
    }),
  };
}

export type NetworksController = ReturnType<typeof createNetworksController>;
