import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "@selio/sdk";
import { z } from "zod";

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../data/agent.db", import.meta.url));
export const DEFAULT_DEPLOYMENTS_DIR = fileURLToPath(new URL("../../../../contracts/deployments", import.meta.url));
export const DEFAULT_PORT = 8788;
export const DEFAULT_MCP_URL = "http://127.0.0.1:8787/mcp";

/**
 * The Dynamic credentials. With none of them set the agent starts in the "not configured" state;
 * with all of them it also needs DYNAMIC_DELEGATION_KEY_FILE.
 */
export const DYNAMIC_KEYS = ["DYNAMIC_ENVIRONMENT_ID", "DYNAMIC_API_TOKEN", "DYNAMIC_WEBHOOK_SECRET"] as const;

// Empty env values count as unset.
const unsetIfEmpty = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const storageKey = z
  .string()
  .refine((v) => {
    const bytes = Buffer.from(v, "base64");
    return bytes.length === 32 && bytes.toString("base64") === v;
  }, "must be the base64 of 32 random bytes");

const envSchema = z.object({
  PORT: unsetIfEmpty(z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT)),
  DB_PATH: unsetIfEmpty(z.string().min(1).default(DEFAULT_DB_PATH)),
  LOG_LEVEL: unsetIfEmpty(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")),
  NODE_ID: unsetIfEmpty(z.string().min(1).default(hostname())),
  CORS_ORIGIN: unsetIfEmpty(z.string().min(1)),
  DEPLOYMENTS_DIR: unsetIfEmpty(z.string().min(1).default(DEFAULT_DEPLOYMENTS_DIR)),
  RPC_MONAD_TESTNET: unsetIfEmpty(z.string().url().default(NETWORKS["monad-testnet"].defaultRpcUrl)),
  MCP_URL: unsetIfEmpty(z.string().url().default(DEFAULT_MCP_URL)),
  SELIO_WEBHOOK_SECRET: unsetIfEmpty(z.string().min(1)),
  DYNAMIC_ENVIRONMENT_ID: unsetIfEmpty(z.string().uuid().optional()),
  DYNAMIC_API_TOKEN: unsetIfEmpty(z.string().min(1).optional()),
  DYNAMIC_DELEGATION_KEY_FILE: unsetIfEmpty(z.string().min(1).optional()),
  DYNAMIC_WEBHOOK_SECRET: unsetIfEmpty(z.string().min(1).optional()),
  DYNAMIC_REVIEW_SECRET: unsetIfEmpty(z.string().min(1).optional()),
  DYNAMIC_REVIEW_SIGNING_KEY_FILE: unsetIfEmpty(z.string().min(1).optional()),
  AGENT_STORAGE_KEY: unsetIfEmpty(storageKey),
  RATE_LIMIT_WINDOW_MS: unsetIfEmpty(z.coerce.number().int().min(1_000).default(60_000)),
  RATE_LIMIT_API: unsetIfEmpty(z.coerce.number().int().min(1).default(120)),
  AGENT_COOLDOWN_MS: unsetIfEmpty(z.coerce.number().int().min(0).default(300_000)),
  AGENT_MAX_GAS: unsetIfEmpty(z.coerce.number().int().min(21_000).default(3_000_000)),
  INTENT_TTL_MS: unsetIfEmpty(z.coerce.number().int().min(1_000).default(120_000)),
  MAX_GRANT_MS: unsetIfEmpty(z.coerce.number().int().min(60_000).default(30 * 24 * 3_600_000)),
  SHUTDOWN_GRACE_MS: unsetIfEmpty(z.coerce.number().int().min(0).default(30_000)),
});

export interface DynamicConfig {
  environmentId: string;
  apiToken: string;
  delegationKeyFile: string;
  webhookSecret: string;
}

export interface AgentOptions {
  cooldownMs: number;
  maxGas: bigint;
  intentTtlMs: number;
  maxGrantMs: number;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  logLevel: string;
  nodeId: string;
  corsOrigin: string;
  deploymentsDir: string;
  rpcUrl: string;
  mcpUrl: string;
  selioWebhookSecret: string;
  /** null: Dynamic is not configured (none of DYNAMIC_KEYS is set). */
  dynamic: DynamicConfig | null;
  reviewSecret?: string;
  reviewSigningKeyFile?: string;
  storageKey: Buffer;
  rateLimits: { windowMs: number; api: number };
  agent: AgentOptions;
  shutdownGraceMs: number;
}

export function loadConfig(vars: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(vars);
  const problems = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  const setKeys = DYNAMIC_KEYS.filter((key) => (vars[key] ?? "") !== "");
  if (setKeys.length > 0 && setKeys.length < DYNAMIC_KEYS.length) {
    const unset = DYNAMIC_KEYS.filter((key) => !setKeys.includes(key));
    problems.push(`Dynamic is partly configured: also set ${unset.join(", ")}`);
  }
  if (setKeys.length === DYNAMIC_KEYS.length && (vars.DYNAMIC_DELEGATION_KEY_FILE ?? "") === "") {
    problems.push("DYNAMIC_DELEGATION_KEY_FILE: Required when Dynamic is configured");
  }
  if (!parsed.success || problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);
  const env = parsed.data;
  return {
    port: env.PORT,
    dbPath: env.DB_PATH,
    logLevel: env.LOG_LEVEL,
    nodeId: env.NODE_ID,
    corsOrigin: env.CORS_ORIGIN,
    deploymentsDir: env.DEPLOYMENTS_DIR,
    rpcUrl: env.RPC_MONAD_TESTNET,
    mcpUrl: env.MCP_URL,
    selioWebhookSecret: env.SELIO_WEBHOOK_SECRET,
    dynamic:
      env.DYNAMIC_ENVIRONMENT_ID && env.DYNAMIC_API_TOKEN && env.DYNAMIC_DELEGATION_KEY_FILE && env.DYNAMIC_WEBHOOK_SECRET
        ? {
            environmentId: env.DYNAMIC_ENVIRONMENT_ID,
            apiToken: env.DYNAMIC_API_TOKEN,
            delegationKeyFile: env.DYNAMIC_DELEGATION_KEY_FILE,
            webhookSecret: env.DYNAMIC_WEBHOOK_SECRET,
          }
        : null,
    ...(env.DYNAMIC_REVIEW_SECRET ? { reviewSecret: env.DYNAMIC_REVIEW_SECRET } : {}),
    ...(env.DYNAMIC_REVIEW_SIGNING_KEY_FILE ? { reviewSigningKeyFile: env.DYNAMIC_REVIEW_SIGNING_KEY_FILE } : {}),
    storageKey: Buffer.from(env.AGENT_STORAGE_KEY, "base64"),
    rateLimits: { windowMs: env.RATE_LIMIT_WINDOW_MS, api: env.RATE_LIMIT_API },
    agent: {
      cooldownMs: env.AGENT_COOLDOWN_MS,
      maxGas: BigInt(env.AGENT_MAX_GAS),
      intentTtlMs: env.INTENT_TTL_MS,
      maxGrantMs: env.MAX_GRANT_MS,
    },
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
  };
}
