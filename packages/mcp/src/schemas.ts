import { z } from "zod";
import { DECIMAL_RE } from "./amounts.js";
import { NETWORK_KEYS } from "./config.js";

/** Contract limit on any discount (ExitMarket.MAX_DISCOUNT_BPS). */
export const MAX_DISCOUNT_BPS = 5_000;
/** Contract limit on a session's length (ExitMarket.MAX_SESSION_DURATION). */
export const MAX_SESSION_SECONDS = 30 * 24 * 3600;

export const networkSchema = z
  .enum(NETWORK_KEYS)
  .describe(
    "Selio network: usdt0-replay (aMonUSDT0 receipts) is Aave V3; monad-testnet and vault-freeze are Morpho (USDC Earn vault shares). monad-testnet is the live Monad testnet; usdt0-replay and vault-freeze are scenario forks.",
  );

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

export const hexSchema = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed hex bytes");

export const amountSchema = z.string().regex(DECIMAL_RE, 'must be a decimal string such as "1.5"');

export const idSchema = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]);

export const discountBpsSchema = z.number().int().min(0).max(MAX_DISCOUNT_BPS);

export const payTokenSchema = z
  .string()
  .min(1)
  .describe("Payment token symbol (for example AUSD, USDT0, WETH) or its address; must be one of the market's pay tokens.");

export const payTokensSchema = z
  .array(payTokenSchema)
  .min(1)
  .optional()
  .describe("Payment tokens accepted, by symbol or address. Defaults to every payment token of the market.");
