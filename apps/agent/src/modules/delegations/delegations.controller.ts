import { DYNAMIC_EVENT_SIGNATURE_HEADER } from "../../shared/crypto/signatures.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import type { DelegationService } from "./delegations.service.js";

export function createDelegationsController(service: DelegationService) {
  return {
    receive: asyncHandler(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      service.handleWebhook(body, req.header(DYNAMIC_EVENT_SIGNATURE_HEADER));
      res.status(200).json({ ok: true });
    }),
  };
}

export type DelegationsController = ReturnType<typeof createDelegationsController>;
