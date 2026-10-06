import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function waitForLog(child: ChildProcess, msg: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`no "${msg}" log line within ${timeoutMs} ms: ${buffered}`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      for (const line of buffered.split("\n")) {
        if (!line.includes(`"msg":"${msg}"`)) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited with ${code}: ${buffered}`)));
  });
}

describe("server", () => {
  it("listens on 127.0.0.1 only", async () => {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "selio-backend-"));
    const child = spawn(process.execPath, [tsxCli, "src/server.ts"], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: join(dir, "selio.db"),
        DEPLOYMENTS_DIR: dir,
        RPC_MONAD_TESTNET: "",
        RPC_USDT0_REPLAY: "",
        RPC_VAULT_FREEZE: "",
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const listening = await waitForLog(child, "listening", 45_000);
      // `host` is the address the operating system reports for the listening socket.
      expect(listening).toMatchObject({ module: "server", host: "127.0.0.1", port });
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(await res.json()).toEqual({ status: "ok" });
      expect(await canConnect("::1", port)).toBe(false);
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((i) => i?.family === "IPv4" && !i.internal);
      if (lan) expect(await canConnect(lan.address, port)).toBe(false);
    } finally {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
