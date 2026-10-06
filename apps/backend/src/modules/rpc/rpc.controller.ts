import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { rpcBodySchema, rpcParamsSchema } from "./rpc.schema.js";
import type { RpcProxyService } from "./rpc.service.js";

export function createRpcController(service: RpcProxyService) {
  return {
    forward: asyncHandler(async (req, res) => {
      const { network } = rpcParamsSchema.parse(req.params);
      const body = rpcBodySchema.parse(req.body);
      res.json(await service.forward(network, body));
    }),
  };
}

export type RpcController = ReturnType<typeof createRpcController>;
