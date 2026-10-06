import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkKey } from "@selio/sdk";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const CONTRACTS_DIR = join(REPO_ROOT, "contracts");

/** Well-known anvil test key #0, used only on local forks. */
export const ANVIL_DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Reads the repo-root `.env` without exporting secrets to the parent process. */
export function readDotEnv(): Record<string, string> {
  const file = join(REPO_ROOT, ".env");
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
  }
  return env;
}

export interface ForkSpec {
  network: NetworkKey;
  port: number;
  forkUrl: string;
  forkBlock?: number;
}

export function forkSpecs(env: Record<string, string>): Record<NetworkKey, ForkSpec> {
  return {
    "usdt0-replay": {
      network: "usdt0-replay",
      port: 8702,
      forkUrl: env.MONAD_ARCHIVE_RPC ?? "https://rpc2.monad.xyz",
      // 2026-08-07 21:30:17 UTC: Aave USDT0 0 withdrawable of 123,720,197 supplied.
      forkBlock: 94_027_500,
    },
    "monad-testnet": {
      network: "monad-testnet",
      port: 8703,
      forkUrl: env.MONAD_TESTNET_RPC ?? "https://testnet-rpc.monad.xyz",
    },
    "vault-freeze": {
      network: "vault-freeze",
      port: 8704,
      forkUrl: env.MONAD_RPC ?? "https://rpc.monad.xyz",
    },
  };
}

/** The process environment with Foundry's default install folder first on the PATH. */
export function toolEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Windows spells it `Path`; keep a single entry.
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = join(homedir(), ".foundry", "bin") + (process.platform === "win32" ? ";" : ":") + (env[key] ?? "");
  return env;
}

/** Public RPCs behind Cloudflare challenge non-browser user agents under load. */
export const FORK_HEADERS = ["User-Agent: Mozilla/5.0 (selio-e2e)"];

export function startAnvil(spec: ForkSpec): ChildProcess {
  const args = ["--fork-url", spec.forkUrl, "--port", String(spec.port), "--silent", "--gas-limit", "100000000"];
  for (const header of FORK_HEADERS) args.push("--fork-header", header);
  if (spec.forkBlock !== undefined) args.push("--fork-block-number", String(spec.forkBlock));
  return spawn("anvil", args, { env: toolEnv(), stdio: "ignore" });
}

/** Runs a command to completion; resolves with its combined output, rejects on a non-zero exit. */
export function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...toolEnv(), ...extraEnv } });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.on("close", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${cmd} exited ${code}: ${output.slice(-2000)}`));
    });
  });
}

/** Deploys Selio to the fork on `spec.port` with the Foundry script and returns the deployment JSON it wrote. */
export async function deployToFork(spec: ForkSpec, opts: { key?: string; outDir?: string } = {}): Promise<unknown> {
  const outDir = opts.outDir ?? "./deployments/local/e2e/";
  mkdirSync(join(CONTRACTS_DIR, outDir), { recursive: true });
  await run(
    "forge",
    ["script", "script/Deploy.s.sol", "--rpc-url", `http://127.0.0.1:${spec.port}`, "--broadcast", "--slow"],
    CONTRACTS_DIR,
    {
      DEPLOY_NETWORK: spec.network,
      PRIVATE_KEY: opts.key ?? ANVIL_DEPLOYER_KEY,
      DEPLOY_OUT_DIR: outDir,
      // Keep fork broadcasts apart from the records of real network deployments.
      FOUNDRY_BROADCAST: "broadcast/forks",
    },
  );
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, outDir, `${spec.network}.json`), "utf8"));
}
