import { maxUint256 } from "viem";
import { z } from "zod";

const BASE_UNITS = /^\d{1,78}$/;
const toBig = (v: string) => (BASE_UNITS.test(v) ? BigInt(v) : null);

const baseUnits = z
  .string()
  .regex(BASE_UNITS, "must be a decimal string of base units")
  .refine((v) => (toBig(v) ?? 0n) <= maxUint256, "must fit in 256 bits");

const discountBps = z.number().int().min(0).max(5_000);

const common = {
  id: z.string().uuid(),
  network: z.literal("monad-testnet"),
  alertId: z.string().uuid(),
  thresholdBps: z.number().int().min(1).max(10_000),
  maxPerAction: baseUnits.refine((v) => (toBig(v) ?? 0n) > 0n, "must be greater than 0"),
  maxTotal: baseUnits,
  expiresAt: z.number().int(),
};

/** C.4: one branch per kind; fields of another kind are rejected. Time and pay-token bounds are checked by the service. */
export const createGrantSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...common,
        kind: z.literal("sell"),
        maxSellDiscountBps: discountBps,
        payMask: z.number().int().min(1).max(255).optional(),
      })
      .strict(),
    z
      .object({ ...common, kind: z.literal("bid"), minBidDiscountBps: discountBps, payIdx: z.number().int().min(0).max(7) })
      .strict(),
    z.object({ ...common, kind: z.literal("vault") }).strict(),
  ])
  .superRefine((g, ctx) => {
    const perAction = toBig(g.maxPerAction);
    const total = toBig(g.maxTotal);
    if (perAction !== null && total !== null && total < perAction) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxTotal"], message: "must be at least maxPerAction" });
    }
  });

export type CreateGrantInput = z.infer<typeof createGrantSchema>;

export const grantIdParamsSchema = z.object({ id: z.string().uuid() });

export const deleteGrantQuerySchema = z.object({
  cancelBid: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});
