import { FetchRpcUpstream } from "./adapters/fetch.adapter.js";
import { createRpcController } from "./rpc.controller.js";
import { createRpcRouter } from "./rpc.routes.js";
import { RpcProxyService, type RpcChainPort } from "./rpc.service.js";
import type { RpcUpstream } from "./rpc.types.js";

export function createRpcModule({ chain, upstream }: { chain: RpcChainPort; upstream?: RpcUpstream }) {
  const service = new RpcProxyService(chain, upstream ?? new FetchRpcUpstream());
  return { service, router: createRpcRouter(createRpcController(service)) };
}

export { ALLOWED_METHODS, RpcProxyService } from "./rpc.service.js";
export { FetchRpcUpstream };
export type { RpcChainPort, RpcUpstream };
export type { JsonRpcRequest, JsonRpcResponse } from "./rpc.types.js";
