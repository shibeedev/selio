import { z } from "zod";
import { addressSchema, networkKeySchema } from "../../shared/utils/validation.js";

/**
 * Syntax only: an https URL, or http://localhost for local development. Whether localhost is allowed at all and
 * whether the host is public is decided by the webhook adapter's `checkTarget`.
 */
export function isAllowedWebhookUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && url.hostname === "localhost";
}

export const createAlertSchema = z.object({
  network: networkKeySchema,
  thresholdBps: z.number().int().min(1).max(10_000),
  webhookUrl: z
    .string()
    .max(2_048)
    .refine(isAllowedWebhookUrl, "webhookUrl must be https, or http://localhost in development")
    .optional(),
  owner: addressSchema,
});

export const ownerQuerySchema = z.object({ owner: addressSchema });

export const alertIdParamsSchema = z.object({ id: z.string().uuid() });

export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export type OwnerQuery = z.infer<typeof ownerQuerySchema>;
export type AlertIdParams = z.infer<typeof alertIdParamsSchema>;
