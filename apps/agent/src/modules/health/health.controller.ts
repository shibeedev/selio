import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { HealthService } from "./health.service.js";

export function createHealthController(service: HealthService) {
  return {
    liveness: asyncHandler(async (_req, res) => {
      res.json({ status: "ok" });
    }),
    readiness: asyncHandler(async (_req, res) => {
      const reason = service.notReadyReason();
      if (reason) throw new AppError(503, ErrorCode.NOT_READY, reason);
      res.json({ status: "ready" });
    }),
  };
}

export type HealthController = ReturnType<typeof createHealthController>;
