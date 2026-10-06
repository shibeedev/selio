import { z } from "zod";

const timestamp = z.union([
  z.number().int().nonnegative(),
  z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be a date"),
]);

/** Dynamic event envelope (Delegation Flow): only the fields the agent reads. */
export const eventEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    eventName: z.string().min(1),
    timestamp,
    environmentId: z.string(),
    userId: z.string().min(1).nullish(),
    data: z.unknown(),
  })
  .passthrough();

const encryptedPayload = z
  .object({ alg: z.string(), iv: z.string(), ct: z.string(), tag: z.string(), ek: z.string(), kid: z.string().optional() })
  .passthrough();

export const delegationCreatedSchema = z
  .object({
    chain: z.string(),
    walletId: z.string().min(1),
    userId: z.string().min(1).nullish(),
    publicKey: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    shareSetId: z.string().min(1).nullish(),
    encryptedDelegatedShare: encryptedPayload,
    encryptedWalletApiKey: encryptedPayload,
  })
  .passthrough();

export const delegationRevokedSchema = z
  .object({
    walletId: z.string().min(1),
    userId: z.string().min(1).nullish(),
    publicKey: z.string().nullish(),
  })
  .passthrough();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const eventTime = (t: EventEnvelope["timestamp"]) => (typeof t === "number" ? t : Date.parse(t));
