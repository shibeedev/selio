import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AppError, ErrorCode } from "../../errors/AppError.js";

export interface McpPort {
  /** Calls a tool and returns its parsed JSON text; throws McpToolError with the tool's text on `isError`. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** A tool result with `isError: true`; the message is the tool's own text. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** MCP client of the hosted endpoint (`MCP_URL`) over Streamable HTTP; connects on first use. */
export class McpClient implements McpPort {
  private client: Promise<Client> | null = null;

  constructor(
    private readonly url: string,
    private readonly version = "0.1.0",
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connected();
    let result: { content?: unknown; isError?: unknown };
    try {
      result = (await client.callTool({ name, arguments: args })) as typeof result;
    } catch (err) {
      this.reset();
      throw new AppError(502, ErrorCode.UPSTREAM_ERROR, `MCP call ${name} failed: ${reason(err)}`);
    }
    const text = Array.isArray(result.content)
      ? result.content
          .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
      : "";
    if (result.isError === true) throw new McpToolError(text || `MCP tool ${name} failed`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(502, ErrorCode.UPSTREAM_ERROR, `MCP tool ${name} did not answer JSON`);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.then((c) => c.close()).catch(() => undefined);
  }

  private connected(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: "selio-agent", version: this.version });
      await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      return client;
    })().catch((err: unknown) => {
      this.client = null;
      throw new AppError(502, ErrorCode.UPSTREAM_ERROR, `MCP server is not reachable: ${reason(err)}`);
    });
    return this.client;
  }

  private reset(): void {
    void this.close();
  }
}
