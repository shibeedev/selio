#!/usr/bin/env node
// stdout carries the MCP protocol; diagnostics go to stderr only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSelioMcpServer, loadMcpConfig } from "./server.js";

async function main(): Promise<void> {
  const server = createSelioMcpServer(loadMcpConfig());
  await server.connect(new StdioServerTransport());
  process.stderr.write("selio-mcp: ready on stdio (read, simulate and build unsigned transactions; never signs)\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`selio-mcp: failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
