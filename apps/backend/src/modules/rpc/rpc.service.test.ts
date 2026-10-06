import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../shared/errors/AppError.js";
import { RpcProxyService, type RpcChainPort } from "./rpc.service.js";
import type { JsonRpcRequest, RpcUpstream } from "./rpc.types.js";

const chain: RpcChainPort = {
  rpcUrl: (key) => (key === "usdt0-replay" ? "http://127.0.0.1:8602" : key === "vault-freeze" ? "http://127.0.0.1:8604" : ""),
};

function upstreamMock() {
  const send = vi.fn(async (_url: string, body: JsonRpcRequest | JsonRpcRequest[]) =>
    Array.isArray(body)
      ? body.map((r) => ({ jsonrpc: "2.0", id: r.id ?? null, result: `${r.method}-ok` }))
      : { jsonrpc: "2.0", id: body.id ?? null, result: `${body.method}-ok` },
  );
  return { send } satisfies RpcUpstream;
}

describe("RpcProxyService", () => {
  it("forwards reads and signed transactions to the fork node", async () => {
    const upstream = upstreamMock();
    const service = new RpcProxyService(chain, upstream);
    const call = { jsonrpc: "2.0" as const, id: 1, method: "eth_call", params: [{ to: "0x01", data: "0x" }, "latest"] };
    const raw = { jsonrpc: "2.0" as const, id: 2, method: "eth_sendRawTransaction", params: ["0x02f8"] };
    await expect(service.forward("usdt0-replay", call)).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: "eth_call-ok" });
    await service.forward("usdt0-replay", raw);
    expect(upstream.send).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8602", call);
    expect(upstream.send).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8602", raw);
  });

  it.each([
    "anvil_setBalance",
    "anvil_impersonateAccount",
    "evm_increaseTime",
    "hardhat_impersonateAccount",
    "eth_sendTransaction",
    "eth_sign",
    "eth_signTypedData_v4",
    "personal_sign",
  ])("never forwards %s", async (method) => {
    const upstream = upstreamMock();
    const reply = await new RpcProxyService(chain, upstream).forward("vault-freeze", { jsonrpc: "2.0", id: 9, method });
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32601, message: `method ${method} is not available on this demo fork` },
    });
    expect(upstream.send).not.toHaveBeenCalled();
  });

  it("answers a mixed batch in order, rejecting only the blocked entries", async () => {
    const upstream = upstreamMock();
    const reply = (await new RpcProxyService(chain, upstream).forward("usdt0-replay", [
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { jsonrpc: "2.0", id: 2, method: "anvil_mine" },
      { jsonrpc: "2.0", id: 3, method: "eth_blockNumber" },
    ])) as { id: number; error?: { code: number } }[];
    expect(reply.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(reply[1]?.error?.code).toBe(-32601);
    expect(reply[0]).toEqual({ jsonrpc: "2.0", id: 1, result: "eth_chainId-ok" });
    expect(upstream.send).toHaveBeenCalledTimes(1);
    expect(upstream.send.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it("refuses live networks, which have public RPCs", async () => {
    const upstream = upstreamMock();
    const err = await new RpcProxyService(chain, upstream)
      .forward("monad-testnet", { jsonrpc: "2.0", id: 1, method: "eth_chainId" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 404, code: "NOT_FOUND", message: "monad-testnet is a live network; use its public RPC" });
    expect(upstream.send).not.toHaveBeenCalled();
  });
});
