import type { Hex } from "viem";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { nonceBodySchema, verifyBodySchema } from "./auth.schema.js";
import type { AuthService } from "./auth.service.js";

export function createAuthController(service: AuthService) {
  return {
    createNonce: asyncHandler(async (req, res) => {
      const { address } = nonceBodySchema.parse(req.body);
      res.json(service.createNonce(address));
    }),
    verify: asyncHandler(async (req, res) => {
      const { message, signature } = verifyBodySchema.parse(req.body);
      res.json(await service.verify(message, signature as Hex));
    }),
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
