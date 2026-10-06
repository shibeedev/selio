import { z } from "zod";
import { networkKeySchema } from "../../shared/utils/validation.js";

export const rpcParamsSchema = z.object({ network: networkKeySchema });

const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
});

/** One request, or a batch of 1 to 50. */
export const rpcBodySchema = z.union([rpcRequestSchema, z.array(rpcRequestSchema).min(1).max(50)]);

export type RpcBody = z.infer<typeof rpcBodySchema>;
