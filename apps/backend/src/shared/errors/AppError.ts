export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_JSON: "INVALID_JSON",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  DEPLOYMENT_NOT_FOUND: "DEPLOYMENT_NOT_FOUND",
  ALERT_NOT_FOUND: "ALERT_NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  FAUCET_FORK_ONLY: "FAUCET_FORK_ONLY",
  FAUCET_RATE_LIMITED: "FAUCET_RATE_LIMITED",
  FAUCET_BUSY: "FAUCET_BUSY",
  UNAUTHORIZED: "UNAUTHORIZED",
  AUTH_FAILED: "AUTH_FAILED",
  INVALID_SIWE_MESSAGE: "INVALID_SIWE_MESSAGE",
  WEBHOOK_NOT_ALLOWED: "WEBHOOK_NOT_ALLOWED",
  ALERT_LIMIT_REACHED: "ALERT_LIMIT_REACHED",
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  NOT_READY: "NOT_READY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An expected failure with its HTTP status; `errorHandler` turns it into `{ code, message, details? }`. */
export class AppError extends Error {
  override readonly name = "AppError";

  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
