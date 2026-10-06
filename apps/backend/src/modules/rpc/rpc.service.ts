import { NETWORKS, type NetworkKey } from "@selio/sdk";
import { AppError } from "../../shared/errors/AppError.js";
import type { ChainGateway } from "../../shared/integrations/chain/chain.gateway.js";
import type { RpcBody } from "./rpc.schema.js";
import type { JsonRpcRequest, JsonRpcResponse, RpcUpstream } from "./rpc.types.js";

export type RpcChainPort = Pick<ChainGateway, "rpcUrl">;

/**
 * Reads, gas and fee queries, logs and pre-signed transactions. Never forwarded: the node's own methods
 * (anvil_*, evm_*, hardhat_*) and anything that signs with its unlocked accounts (eth_sendTransaction, eth_sign*,
 * personal_*).
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "web3_clientVersion",
  "eth_syncing",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_createAccessList",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_sendRawTransaction",
]);

function reject(r: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: r.id ?? null,
    error: { code: -32601, message: `method ${r.method} is not available on this demo fork` },
  };
}

export class RpcProxyService {
  constructor(
    private readonly chain: RpcChainPort,
    private readonly upstream: RpcUpstream,
  ) {}

  async forward(network: NetworkKey, body: RpcBody): Promise<unknown> {
    if (!NETWORKS[network].isFork) throw new AppError(404, "NOT_FOUND", `${network} is a live network; use its public RPC`);
    const url = this.chain.rpcUrl(network);
    if (!Array.isArray(body)) return ALLOWED_METHODS.has(body.method) ? this.upstream.send(url, body) : reject(body);

    const allowed = body.filter((r) => ALLOWED_METHODS.has(r.method));
    const replies = new Map<unknown, unknown>();
    if (allowed.length > 0) {
      const reply = await this.upstream.send(url, allowed);
      for (const r of Array.isArray(reply) ? reply : [reply]) {
        if (typeof r === "object" && r !== null) replies.set((r as { id?: unknown }).id ?? null, r);
      }
    }
    // Replies come back in request order; blocked entries get their own error.
    return body.map((r) => (ALLOWED_METHODS.has(r.method) ? (replies.get(r.id ?? null) ?? reject(r)) : reject(r)));
  }
}
