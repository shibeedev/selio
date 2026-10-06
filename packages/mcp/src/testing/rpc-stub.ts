import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeFunctionResult, erc20Abi, type Hex } from "viem";
import { aaveExitMarketAbi } from "@selio/sdk";

interface RpcMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown[];
}

/** Starts a node:http server on a free local port and returns its base URL and a closer. */
export async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function resultOf(data: Hex): Hex {
  try {
    const call = decodeFunctionData({ abi: aaveExitMarketAbi, data });
    if (call.functionName === "capacity") {
      return encodeFunctionResult({
        abi: aaveExitMarketAbi,
        functionName: "capacity",
        result: {
          withdrawable: 0n,
          supplied: 1_000_000n,
          utilizationBps: 10_000n,
          debtorCapacity: 1_000_000n,
          sessionAssets: 0n,
        },
      });
    }
    if (call.functionName === "bidCapacityAt") {
      return encodeFunctionResult({ abi: aaveExitMarketAbi, functionName: "bidCapacityAt", result: 0n });
    }
  } catch {
    // Not a market call: fall through to the token reads.
  }
  const call = decodeFunctionData({ abi: erc20Abi, data });
  if (call.functionName === "symbol") return encodeFunctionResult({ abi: erc20Abi, functionName: "symbol", result: "USDT0" });
  if (call.functionName === "decimals") return encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 });
  throw new Error(`unexpected call ${data.slice(0, 10)}`);
}

function answer(message: RpcMessage) {
  const tx = message.params?.[0] as { data?: Hex } | undefined;
  if (message.method !== "eth_call" || !tx?.data) {
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } };
  }
  return { jsonrpc: "2.0", id: message.id, result: resultOf(tx.data) };
}

/** A JSON-RPC node that answers the reads of get_exit_capacity on the Aave fixture and counts the requests it serves. */
export async function startRpcStub() {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as RpcMessage | RpcMessage[];
      const messages = Array.isArray(body) ? body : [body];
      requests += messages.length;
      const replies = messages.map(answer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    });
  });
  const { url, close } = await listen(server);
  return { url, close, requests: () => requests };
}
