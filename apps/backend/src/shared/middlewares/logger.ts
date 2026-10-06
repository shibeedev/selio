import { pino, type Logger as PinoLogger } from "pino";
import { pinoHttp } from "pino-http";

export type Logger = PinoLogger;

export function createLogger({ nodeId, level }: { nodeId: string; level: string }): Logger {
  // pino-http logs request headers, so session tokens would otherwise reach the log.
  return pino({ level, base: { nodeId }, redact: ["req.headers.authorization"] });
}

export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger: logger.child({ module: "http" }),
    genReqId: (req) => req.id,
    customProps: (req) => ({ requestId: req.id }),
  });
}
