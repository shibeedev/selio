import {
  bidderKit,
  borrowerKit,
  defaultBidderAmounts,
  kitContext,
  sellerKit,
  type KitContext,
} from "@selio/forkkit";
import type { NetworkKey } from "@selio/sdk";
import { formatUnits, getAddress, type Address } from "viem";
import { AppError } from "../../../shared/errors/AppError.js";
import type { ChainGateway } from "../../../shared/integrations/chain/chain.gateway.js";
import type { KitRunner, KitType } from "../faucet.types.js";

export type ForkkitChainPort = Pick<ChainGateway, "publicClient" | "requireDeployment">;

// Receipts worth 10 WETH or 10,000 USDC; debt of 5 WETH or 5,000 USDC.
function units(decimals: number, ethLike: bigint, stable: bigint): bigint {
  return (decimals === 6 ? stable : ethLike) * 10n ** BigInt(decimals);
}

function reason(err: unknown): string {
  if (err instanceof Error) {
    const short = (err as { shortMessage?: unknown }).shortMessage;
    return typeof short === "string" ? short : err.message;
  }
  return "unknown error";
}

/** Runs the fork kits through anvil impersonation and describes what each one did. */
export class ForkkitAdapter implements KitRunner {
  constructor(private readonly chain: ForkkitChainPort) {}

  async runKit(network: NetworkKey, kit: KitType, address: string): Promise<string[]> {
    const deployment = this.chain.requireDeployment(network);
    const user = getAddress(address);
    const ctx = kitContext(this.chain.publicClient(network), deployment);
    try {
      if (kit === "seller") return await this.seller(ctx, user);
      if (kit === "borrower") return await this.borrower(ctx, user);
      return await this.bidder(ctx, user);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, "UPSTREAM_ERROR", `Preparing the ${kit} kit on ${network} failed: ${reason(err)}`);
    }
  }

  private async seller(ctx: KitContext, user: Address): Promise<string[]> {
    const d = ctx.deployment;
    const [underlying, receipt] = await Promise.all([ctx.sdk.token(d.underlying), ctx.sdk.token(d.receipt)]);
    const amount = units(underlying.decimals, 10n, 10_000n);
    await sellerKit(ctx, user, amount);
    const where = d.venue === "aave" ? "the Aave pool" : "the Earn vault";
    return [
      `Funded ${user} with 10 MON for gas`,
      `Deposited ${formatUnits(amount, underlying.decimals)} ${underlying.symbol} into ${where} for ${user}, who now holds ${receipt.symbol} deposit receipts`,
      "Re-froze the pool so the receipts cannot be withdrawn directly",
    ];
  }

  private async borrower(ctx: KitContext, user: Address): Promise<string[]> {
    const d = ctx.deployment;
    const underlying = await ctx.sdk.token(d.underlying);
    const debt = units(underlying.decimals, 5n, 5_000n);
    // WETH (pay token 3) is the borrower kit's collateral on the Aave network.
    const collateralToken = d.venue === "aave" ? d.payTokens[3] : d.collateral;
    const collateral = collateralToken ? (await ctx.sdk.token(collateralToken)).symbol : "collateral";
    await borrowerKit(ctx, user, debt);
    return [
      `Funded ${user} with 10 MON for gas`,
      `Supplied ${collateral} collateral and borrowed ${formatUnits(debt, underlying.decimals)} ${underlying.symbol} for ${user}`,
      "Re-froze the pool so the new debt can be repaid by buying receipts",
    ];
  }

  private async bidder(ctx: KitContext, user: Address): Promise<string[]> {
    const amounts = await defaultBidderAmounts(ctx);
    await bidderKit(ctx, user, amounts);
    const lines = [`Funded ${user} with 10 MON for gas`];
    for (const [token, amount] of Object.entries(amounts)) {
      const t = await ctx.sdk.token(token as Address);
      lines.push(`Sent ${formatUnits(amount, t.decimals)} ${t.symbol} to ${user}`);
    }
    return lines;
  }
}
