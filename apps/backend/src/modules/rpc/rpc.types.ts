export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** The fork node behind the proxy; resolves its JSON reply unchanged. */
export interface RpcUpstream {
  send(url: string, body: JsonRpcRequest | JsonRpcRequest[]): Promise<unknown>;
}
