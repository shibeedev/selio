import { NETWORKS, type NetworkKey } from "@selio/sdk";
import { z } from "zod";

export const NETWORK_KEYS = Object.keys(NETWORKS) as [NetworkKey, ...NetworkKey[]];

export const networkKeySchema = z.enum(NETWORK_KEYS);

export function toNetworkKey(value: string): NetworkKey {
  return networkKeySchema.parse(value);
}

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((a) => a.toLowerCase());
