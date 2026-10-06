import { SELIO_SIGNATURE_HEADER } from "../../shared/crypto/signatures.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { TriggerService } from "./triggers.service.js";

export function createTriggersController(service: TriggerService) {
  return {
    receive: asyncHandler(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = service.onAlert(String(req.params.grantId), body, req.header(SELIO_SIGNATURE_HEADER));
      res.status(result.status).json(result.body);
    }),
  };
}

export type TriggersController = ReturnType<typeof createTriggersController>;
