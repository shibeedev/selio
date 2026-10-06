import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS, type NetworkKey } from "@selio/sdk";
import { z } from "zod";
import type { RequestLimits } from "../shared/middlewares/rateLimit.js";

export const DEFAULT_DB_PATH = join(fileURLToPath(new URL("../../", import.meta.url)), "data", "selio.db");
export const DEFAULT_DEPLOYMENTS_DIR = join(fileURLToPath(new URL("../../../../", import.meta.url)), "contracts", "deployments");

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

// Empty env values count as unset.
const env = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const envSchema = z.object({
  PORT: env(z.coerce.number().int().min(1).max(65_535).default(8_787)),
  DB_PATH: env(z.string().min(1).default(DEFAULT_DB_PATH)),
  POLL_INTERVAL_MS: env(z.coerce.number().int().min(1_000).default(60_000)),
  WEBHOOK_SECRET: env(z.string().min(1).optional()),
  CORS_ORIGIN: env(z.string().min(1).default("*")),
  DEPLOYMENTS_DIR: env(z.string().min(1).default(DEFAULT_DEPLOYMENTS_DIR)),
  NODE_ID: env(z.string().min(1).default(hostname())),
  LOG_LEVEL: env(z.enum(LOG_LEVELS).default("info")),
  NODE_ENV: env(z.string().optional()),
  RATE_LIMIT_WINDOW_MS: env(z.coerce.number().int().min(1_000).default(60_000)),
  RATE_LIMIT_API: env(z.coerce.number().int().min(1).default(300)),
  RATE_LIMIT_MCP: env(z.coerce.number().int().min(1).default(120)),
  RATE_LIMIT_RPC: env(z.coerce.number().int().min(1).default(1_200)),
  MCP_MAX_READS_PER_REQUEST: env(z.coerce.number().int().min(1).default(300)),
});

export interface AppConfig {
  port: number;
  dbPath: string;
  pollIntervalMs: number;
  webhookSecret?: string;
  corsOrigin: string;
  deploymentsDir: string;
  rpcUrls: Partial<Record<NetworkKey, string>>;
  nodeId: string;
  logLevel: (typeof LOG_LEVELS)[number];
  /** `http://localhost` webhooks are accepted only when NODE_ENV=development. */
  allowLocalhostWebhooks: boolean;
  rateLimits: RequestLimits;
  mcpMaxReadsPerRequest: number;
}

export function rpcEnvName(key: NetworkKey): string {
  return `RPC_${key.toUpperCase().replace(/-/g, "_")}`;
}

/** Validates the environment once; throws with every problem listed. */
export function loadConfig(vars: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(vars);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

  const rpcUrls: Partial<Record<NetworkKey, string>> = {};
  for (const key of Object.keys(NETWORKS) as NetworkKey[]) {
    const name = rpcEnvName(key);
    const value = vars[name];
    if (value === undefined || value === "") continue;
    if (z.string().url().safeParse(value).success) rpcUrls[key] = value;
    else problems.push(`${name}: must be a URL`);
  }

  if (!parsed.success || problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  const e = parsed.data;
  return {
    port: e.PORT,
    dbPath: e.DB_PATH,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    ...(e.WEBHOOK_SECRET ? { webhookSecret: e.WEBHOOK_SECRET } : {}),
    corsOrigin: e.CORS_ORIGIN,
    deploymentsDir: e.DEPLOYMENTS_DIR,
    rpcUrls,
    nodeId: e.NODE_ID,
    logLevel: e.LOG_LEVEL,
    allowLocalhostWebhooks: e.NODE_ENV === "development",
    rateLimits: {
      windowMs: e.RATE_LIMIT_WINDOW_MS,
      api: e.RATE_LIMIT_API,
      mcp: e.RATE_LIMIT_MCP,
      rpc: e.RATE_LIMIT_RPC,
    },
    mcpMaxReadsPerRequest: e.MCP_MAX_READS_PER_REQUEST,
  };
}
