import { Router } from "express";
import type { RpcController } from "./rpc.controller.js";

export function createRpcRouter(controller: RpcController): Router {
  const router = Router();
  router.post("/rpc/:network", controller.forward);
  return router;
}
