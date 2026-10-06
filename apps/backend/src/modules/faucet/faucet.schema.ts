import { z } from "zod";
import { addressSchema, networkKeySchema } from "../../shared/utils/validation.js";
import type { KitType } from "./faucet.types.js";

export const KIT_TYPES = ["seller", "borrower", "bidder"] as const satisfies readonly KitType[];

export const requestKitSchema = z.object({
  network: networkKeySchema,
  address: addressSchema,
  kit: z.enum(KIT_TYPES),
});

export type RequestKitInput = z.infer<typeof requestKitSchema>;
