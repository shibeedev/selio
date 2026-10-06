import { AppError } from "../../../shared/errors/AppError.js";
import type { JsonRpcRequest, RpcUpstream } from "../rpc.types.js";

function unreachable(): AppError {
  return new AppError(502, "UPSTREAM_ERROR", "fork node is not reachable");
}

export class FetchRpcUpstream implements RpcUpstream {
  constructor(private readonly timeoutMs = 30_000) {}

  /** A network error, a timeout or a reply that is not JSON all count as unreachable. */
  async send(url: string, body: JsonRpcRequest | JsonRpcRequest[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw unreachable();
    }
    if (!res.ok) throw new AppError(502, "UPSTREAM_ERROR", `fork node answered HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw unreachable();
    }
  }
}
