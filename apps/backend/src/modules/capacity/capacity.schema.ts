import { z } from "zod";
import { networkKeySchema } from "../../shared/utils/validation.js";
import { MAX_HISTORY_HOURS } from "./capacity.types.js";

export const capacityParamsSchema = z.object({ network: networkKeySchema });

export const capacityHistoryQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(MAX_HISTORY_HOURS).default(24),
});

export type CapacityParams = z.infer<typeof capacityParamsSchema>;
export type CapacityHistoryQuery = z.infer<typeof capacityHistoryQuerySchema>;
