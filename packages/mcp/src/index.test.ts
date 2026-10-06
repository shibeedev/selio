import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

/** Starts the stdio bin from source with only the given SELIO_* variables set. */
function startBin(env: Record<string, string>) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("SELIO_")));
  return spawn(process.execPath, ["--import", "tsx", entry], { env: { ...base, ...env }, stdio: "pipe" });
}

describe("selio-mcp (stdio)", () => {
  it("refuses to start with an RPC value that is not a URL", async () => {
    const bin = startBin({ SELIO_RPC_USDT0_REPLAY: "not a url" });
    let stderr = "";
    bin.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => bin.on("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toContain(
      "selio-mcp: failed to start: Invalid configuration: SELIO_RPC_USDT0_REPLAY: must be a URL\n",
    );
  }, 30_000);

  it("serves MCP on stdout and writes diagnostics to stderr", async () => {
    const bin = startBin({});
    const readyLine = "selio-mcp: ready on stdio (read, simulate and build unsigned transactions; never signs)\n";
    let stderr = "";
    let stdout = "";
    const ready = new Promise<void>((resolve) => {
      bin.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes(readyLine)) resolve();
      });
    });
    const reply = new Promise<string>((resolve) => {
      bin.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("\n")) resolve(stdout.split("\n")[0]!);
      });
    });
    bin.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "selio-test", version: "0.0.0" } },
      })}\n`,
    );
    const [line] = await Promise.all([reply, ready]);
    bin.kill();
    const message = JSON.parse(line) as { id: number; result: { serverInfo: { name: string } } };
    expect(message.id).toBe(1);
    expect(message.result.serverInfo.name).toBe("selio");
    expect(stderr).toBe(readyLine);
  }, 30_000);
});
