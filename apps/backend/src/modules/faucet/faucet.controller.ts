import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { clientIp, ipBucket } from "../../shared/utils/clientIp.js";
import { requestKitSchema } from "./faucet.schema.js";
import type { FaucetService } from "./faucet.service.js";

export function createFaucetController(service: FaucetService) {
  return {
    requestKit: asyncHandler(async (req, res) => {
      const input = requestKitSchema.parse(req.body);
      res.json(await service.requestKit({ ...input, ip: ipBucket(clientIp(req)) }));
    }),
  };
}

export type FaucetController = ReturnType<typeof createFaucetController>;
