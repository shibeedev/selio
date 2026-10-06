import { Router } from "express";
import type { NetworksController } from "./networks.controller.js";

export function createNetworksRouter(controller: NetworksController): Router {
  const router = Router();
  router.get("/api/networks", controller.getNetworks);
  return router;
}
