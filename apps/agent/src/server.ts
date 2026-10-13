import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp, type AppDeps } from "./app.js";
import { DYNAMIC_KEYS, loadConfig, type AppConfig } from "./config/index.js";
import { openDatabase } from "./shared/db/database.js";
import { migrate } from "./shared/db/migrations.js";
import { ChainGateway } from "./shared/integrations/chain/chain.gateway.js";
import { createDynamicGateway, type DynamicPort } from "./shared/integrations/dynamic/dynamic.gateway.js";
import { McpClient } from "./shared/integrations/mcp/mcp.client.js";
import { createLogger, errorFields } from "./shared/middlewares/logger.js";
import { createTokenVerifier, dynamicCredentialLookup, dynamicJwks } from "./shared/middlewares/requireDynamicUser.js";

const HOST = "127.0.0.1";

function exitWith(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    exitWith(err instanceof Error ? err.message : String(err));
  }
}

/** Reads a private key PEM at start-up; the process stops when it is missing or of another type. */
function readPrivateKey(path: string, variable: string, type: "rsa" | "ed25519"): { pem: string; key: KeyObject } {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    exitWith(`${variable}: cannot read ${path}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    exitWith(`${variable}: ${path} is not a private key PEM`);
  }
  if (key.asymmetricKeyType !== type) exitWith(`${variable}: ${path} must hold an ${type === "rsa" ? "RSA" : "Ed25519"} private key`);
  return { pem, key };
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ nodeId: config.nodeId, level: config.logLevel });
  const log = logger.child({ module: "server" });
  const db = openDatabase(config.dbPath);
  migrate(db);

  let dynamic: AppDeps["dynamic"] = null;
  if (config.dynamic) {
    const { environmentId, apiToken, delegationKeyFile, webhookSecret } = config.dynamic;
    const { pem } = readPrivateKey(delegationKeyFile, "DYNAMIC_DELEGATION_KEY_FILE", "rsa");
    let gateway: DynamicPort;
    try {
      gateway = await createDynamicGateway({ environmentId, apiToken, privateKeyPem: pem });
    } catch (err) {
      exitWith(
        `Dynamic's server SDK could not be loaded (${err instanceof Error ? err.message : String(err)}); it runs on Linux and macOS only`,
      );
    }
    dynamic = {
      environmentId,
      webhookSecret,
      gateway,
      verifyToken: createTokenVerifier(environmentId, dynamicJwks(environmentId), dynamicCredentialLookup(environmentId, apiToken)),
    };
  } else {
    log.warn({ missing: DYNAMIC_KEYS }, "dynamic not configured: grants, delegations and signing are off until it is");
  }
  const signingKey = config.reviewSigningKeyFile
    ? readPrivateKey(config.reviewSigningKeyFile, "DYNAMIC_REVIEW_SIGNING_KEY_FILE", "ed25519").key
    : undefined;
  if (!config.reviewSecret) log.warn("DYNAMIC_REVIEW_SECRET is not set: Transaction Review requests are refused");

  const mcp = new McpClient(config.mcpUrl);
  const { app, executor } = createApp({
    db,
    logger,
    corsOrigin: config.corsOrigin,
    selioWebhookSecret: config.selioWebhookSecret,
    storageKey: config.storageKey,
    chain: new ChainGateway({ deploymentsDir: config.deploymentsDir, rpcUrl: config.rpcUrl }),
    mcp,
    dynamic,
    review: {
      ...(config.reviewSecret ? { secret: config.reviewSecret } : {}),
      ...(signingKey ? { signingKey } : {}),
    },
    agent: config.agent,
    requestLimits: config.rateLimits,
  });

  // Actions created after this point belong to this process; older unfinished ones are reconciled.
  const reconcileUpTo = executor.lastActionId();
  const server = app.listen(config.port, HOST, () => {
    log.info(
      { port: config.port, host: HOST, deploymentsDir: config.deploymentsDir, mcpUrl: config.mcpUrl, dynamic: dynamic !== null },
      "listening",
    );
    executor.reconcile(reconcileUpTo).catch((err: unknown) => log.error({ error: errorFields(err) }, "reconciliation failed"));
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, config.shutdownGraceMs + 5_000);
    force.unref();
    void (async () => {
      // Stop accepting connections, let running actions finish up to the grace period, then close.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      if (!(await executor.drain(config.shutdownGraceMs))) log.warn("actions still running at shutdown");
      await closed;
      await mcp.close();
      db.close();
      log.info("stopped");
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
