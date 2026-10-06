import { z } from "zod";

/** The backend's alert webhook payload (Part 6 §E.7). */
export const alertPayloadSchema = z.object({
  type: z.string(),
  network: z.string(),
  utilizationBps: z.number().int().min(0),
  thresholdBps: z.number().int(),
  withdrawable: z.string(),
  supplied: z.string(),
  at: z.number().int().min(0),
});

export type AlertPayload = z.infer<typeof alertPayloadSchema>;

export const ALERT_TYPE = "selio.capacity.alert";
