import type { Hex } from "viem";
import { z } from "zod";
import { decodeRevert } from "../revert.js";
import { addressSchema, hexSchema, networkSchema } from "../schemas.js";
import { toAddress, type ToolContext } from "./common.js";

export const simulateTransactionShape = {
  network: networkSchema,
  from: addressSchema.describe("Address that would send the transaction."),
  to: addressSchema.describe("Transaction target (the `to` of a built transaction)."),
  data: hexSchema.describe("Calldata (the `data` of a built transaction)."),
  value: z.string().regex(/^\d+$/).optional().describe("Native value in wei as a decimal string. Default 0."),
};
export type SimulateTransactionArgs = z.infer<z.ZodObject<typeof simulateTransactionShape>>;

export async function simulateTransaction(ctx: ToolContext, args: SimulateTransactionArgs) {
  const h = ctx.chain.get(args.network);
  const outcome = await h.reads.call({
    from: toAddress(args.from, "from"),
    to: toAddress(args.to, "to"),
    data: args.data as Hex,
    value: BigInt(args.value ?? "0"),
  });
  if (outcome.ok) return { network: args.network, ok: true, returnData: outcome.returnData };
  return {
    network: args.network,
    ok: false,
    revert: decodeRevert(outcome.revertData),
    revertData: outcome.revertData ?? null,
    message: outcome.message,
    notes: [
      "Do not send a transaction whose simulation fails. Earlier transactions of a build (approvals) must be confirmed before later ones simulate correctly.",
    ],
  };
}
