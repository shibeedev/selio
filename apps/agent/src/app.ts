import type { KeyObject } from "node:crypto";
import express from "express";
import { DYNAMIC_KEYS, type AgentOptions } from "./config/index.js";
import { createDelegationsModule, DelegationRepository } from "./modules/delegations/index.js";
import { ActionRepository, createExecutorModule, IntentRepository } from "./modules/executor/index.js";
import { createGrantsModule, GrantRepository } from "./modules/grants/index.js";
import { createHealthModule } from "./modules/health/index.js";
import { createReviewModule } from "./modules/review/index.js";
import { createTriggersModule } from "./modules/triggers/index.js";
import { createTransactional, type Db } from "./shared/db/database.js";
import { RateLimits } from "./shared/db/rateLimits.js";
import type { ChainPort } from "./shared/integrations/chain/chain.gateway.js";
import type { DynamicPort } from "./shared/integrations/dynamic/dynamic.gateway.js";
import type { McpPort } from "./shared/integrations/mcp/mcp.client.js";
import { cors } from "./shared/middlewares/cors.js";
import { errorHandler } from "./shared/middlewares/errorHandler.js";
import { httpLogger, type Logger } from "./shared/middlewares/logger.js";
import { notFound } from "./shared/middlewares/notFound.js";
import { rateLimit } from "./shared/middlewares/rateLimit.js";
import { requestId } from "./shared/middlewares/requestId.js";
import type { TokenVerifier } from "./shared/middlewares/requireDynamicUser.js";

export interface AppDeps {
  db: Db;
  logger: Logger;
  corsOrigin: string;
  /** The backend's WEBHOOK_SECRET; alert hooks must carry its signature. */
  selioWebhookSecret: string;
  storageKey: Buffer;
  chain: ChainPort;
  mcp: McpPort;
  /** null while Dynamic is not configured (the "not configured" state). */
  dynamic: { environmentId: string; webhookSecret: string; gateway: DynamicPort; verifyToken: TokenVerifier } | null;
  review?: { secret?: string; signingKey?: KeyObject };
  agent: AgentOptions;
  /** Per-IP limit on /agent/v1/*; without it no request limit applies. */
  requestLimits?: { windowMs: number; api: number };
  now?: () => number;
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const inTransaction = createTransactional(deps.db);
  const app = express();
  app.disable("x-powered-by");
  app.set("json replacer", (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

  app.use(requestId());
  app.use(httpLogger(deps.logger));
  app.use(cors(deps.corsOrigin));
  if (deps.requestLimits) {
    app.use(rateLimit({ limits: new RateLimits(deps.db), now, windowMs: deps.requestLimits.windowMs, max: deps.requestLimits.api }));
  }

  const grants = new GrantRepository(deps.db);
  const actions = new ActionRepository(deps.db);
  const intents = new IntentRepository(deps.db);
  const dynamic = deps.dynamic;
  const delegations = createDelegationsModule({
    repo: new DelegationRepository(deps.db),
    grants,
    inTransaction,
    logger: deps.logger,
    storageKey: deps.storageKey,
    dynamic: dynamic ? { environmentId: dynamic.environmentId, webhookSecret: dynamic.webhookSecret, gateway: dynamic.gateway } : null,
    pruneEveryMs: deps.agent.intentTtlMs,
    now,
  });
  const executor = createExecutorModule({
    actions,
    intents,
    grants,
    delegations: delegations.service,
    chain: deps.chain,
    mcp: deps.mcp,
    dynamic: dynamic?.gateway ?? null,
    inTransaction,
    logger: deps.logger,
    options: { maxGas: deps.agent.maxGas, intentTtlMs: deps.agent.intentTtlMs, storageKey: deps.storageKey },
    now,
  });
  const triggers = createTriggersModule({
    grants,
    actions,
    executor: executor.service,
    inTransaction,
    logger: deps.logger,
    options: { webhookSecret: deps.selioWebhookSecret, cooldownMs: deps.agent.cooldownMs },
    now,
  });
  const review = createReviewModule({
    intents,
    delegations: delegations.service,
    chain: deps.chain,
    inTransaction,
    logger: deps.logger,
    options: deps.review ?? {},
    now,
  });
  const grantRoutes = createGrantsModule({
    grants,
    actions,
    delegations: delegations.service,
    executor: executor.service,
    dynamic: dynamic?.gateway ?? null,
    verifyToken: dynamic?.verifyToken ?? null,
    payTokenCount: () => deps.chain.deployment().payTokens.length,
    inTransaction,
    logger: deps.logger,
    options: { maxGrantMs: deps.agent.maxGrantMs },
    now,
  });

  // Raw-body routes before the JSON parser: each webhook signature covers the exact bytes received.
  app.use(triggers.router);
  app.use(delegations.router);
  app.use(review.router);
  app.use(express.json({ limit: "1mb" }));
  app.use(createHealthModule({ db: deps.db, dynamicMissing: dynamic ? [] : DYNAMIC_KEYS }).router);
  app.use(grantRoutes.router);
  app.use(notFound());
  app.use(errorHandler(deps.logger));

  return { app, executor: executor.service };
}
