import type { SelioChain } from "@selio/mcp";
import express from "express";
import { createAlertsModule, type WebhookSender } from "./modules/alerts/index.js";
import { createAuthModule } from "./modules/auth/index.js";
import { createCapacityModule, type CapacityChainPort } from "./modules/capacity/index.js";
import {
  createFaucetModule,
  type FaucetServiceOptions,
  type ForkkitChainPort,
  type KitRunner,
} from "./modules/faucet/index.js";
import { createHealthModule } from "./modules/health/index.js";
import { createMcpModule } from "./modules/mcp/index.js";
import { createNetworksModule, type NetworksChainPort } from "./modules/networks/index.js";
import { createRpcModule, type RpcChainPort, type RpcUpstream } from "./modules/rpc/index.js";
import type { Db } from "./shared/db/database.js";
import { RateLimits } from "./shared/db/rateLimits.js";
import { cors } from "./shared/middlewares/cors.js";
import { errorHandler, notFound } from "./shared/middlewares/errorHandler.js";
import { httpLogger, type Logger } from "./shared/middlewares/logger.js";
import { rateLimit, type RequestLimits } from "./shared/middlewares/rateLimit.js";
import { requestId } from "./shared/middlewares/requestId.js";

export type AppChainPort = NetworksChainPort & CapacityChainPort & ForkkitChainPort & RpcChainPort;

export interface AppDeps {
  db: Db;
  logger: Logger;
  chain: AppChainPort;
  /** Chain layer of the MCP server, shared by every /mcp request. */
  mcpChain: SelioChain;
  corsOrigin: string;
  webhookSecret?: string;
  kits?: KitRunner;
  webhook?: WebhookSender;
  faucetOptions?: Partial<FaucetServiceOptions>;
  rpcUpstream?: RpcUpstream;
  now?: () => number;
  /** Per-IP request limits; without them no request is limited. */
  requestLimits?: RequestLimits;
  mcpMaxReadsPerRequest?: number;
  allowLocalhostWebhooks?: boolean;
}

/** Sign-in domains: any with CORS_ORIGIN="*", else the hosts (port included) of the allowed web origins. */
function signInDomains(corsOrigin: string): "*" | string[] {
  if (corsOrigin === "*") return "*";
  return corsOrigin
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).host;
      } catch {
        return origin;
      }
    });
}

export function createApp(deps: AppDeps) {
  const { db, logger, chain, now } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

  const limits = new RateLimits(db);
  app.use(requestId());
  app.use(httpLogger(logger));
  app.use(cors(deps.corsOrigin));
  if (deps.requestLimits) {
    const { windowMs, api, mcp, rpc } = deps.requestLimits;
    app.use(rateLimit({ limits, now: now ?? Date.now, windowMs, max: { api, mcp, rpc } }));
  }
  app.use(express.json({ limit: "1mb" }));

  const capacity = createCapacityModule({ db, chain, logger, now });
  const auth = createAuthModule({ db, logger, allowedDomains: signInDomains(deps.corsOrigin), now });
  const alerts = createAlertsModule({
    db,
    logger,
    sessions: auth.service,
    limits,
    webhookSecret: deps.webhookSecret,
    webhook: deps.webhook,
    allowLocalhostWebhooks: deps.allowLocalhostWebhooks,
    now,
  });
  const faucetOptions = now ? { now, ...deps.faucetOptions } : deps.faucetOptions;
  const faucet = createFaucetModule({ db, chain, logger, kits: deps.kits, options: faucetOptions });

  app.use(createHealthModule({ db }).router);
  app.use(createNetworksModule({ chain }).router);
  app.use(capacity.router);
  app.use(auth.router);
  app.use(alerts.router);
  app.use(faucet.router);
  app.use(createMcpModule({ chain: deps.mcpChain, maxReadsPerRequest: deps.mcpMaxReadsPerRequest }).router);
  app.use(createRpcModule({ chain, upstream: deps.rpcUpstream }).router);
  app.use(notFound());
  app.use(errorHandler(logger));

  return { app, capacity, alerts };
}
