import { z } from "zod";
import { addressSchema } from "../../shared/utils/validation.js";

export const nonceBodySchema = z.object({ address: addressSchema });

export const verifyBodySchema = z.object({
  message: z.string().min(1).max(2_048),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "must be a 65-byte 0x-prefixed hex signature"),
});

export type NonceBody = z.infer<typeof nonceBodySchema>;
export type VerifyBody = z.infer<typeof verifyBodySchema>;
