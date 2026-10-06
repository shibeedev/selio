import { pino, type Logger as PinoLogger } from "pino";
import { pinoHttp } from "pino-http";

export type Logger = PinoLogger;

// pino-http logs request and response headers, so tokens and signatures are redacted.
const REDACT = [
  "req.headers.authorization",
  'req.headers["x-dynamic-signature-256"]',
  'req.headers["x-dynamic-signature"]',
  'req.headers["x-selio-signature"]',
  'res.headers["x-dynamic-response-signature"]',
];

export function createLogger({ nodeId, level }: { nodeId: string; level: string }): Logger {
  return pino({ level, base: { nodeId }, redact: REDACT });
}

export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger: logger.child({ module: "http" }),
    genReqId: (req) => req.id,
    customProps: (req) => ({ requestId: req.id }),
  });
}

/** Error fields safe to log: never the enumerable properties, which can carry request headers. */
export function errorFields(err: unknown): { type: string; message: string; stack?: string } {
  return err instanceof Error
    ? { type: err.name, message: err.message, stack: err.stack }
    : { type: typeof err, message: String(err) };
}
