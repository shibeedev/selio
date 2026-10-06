import { formatUnits, maxUint256, type Address } from "viem";
import { z } from "zod";
import { BPS, type TokenInfo } from "@selio/sdk";
import { amountView, bpsView, parsePositiveAmount, type AmountView } from "../amounts.js";
import { ToolError } from "../errors.js";
import {
  addressSchema,
  amountSchema,
  discountBpsSchema,
  idSchema,
  networkSchema,
  payTokenSchema,
  payTokensSchema,
} from "../schemas.js";
import {
  resolvePayToken,
  resolvePayTokens,
  sameAddress,
  toAddress,
  toId,
  type ToolContext,
} from "./common.js";

/** Discount levels reported by get_exit_capacity: 1, 3, 5, 10 and 20%. */
export const CAPACITY_DISCOUNT_LEVELS = [100, 300, 500, 1_000, 2_000] as const;
/** Bids per list_bids page when the caller gives no limit. */
export const LIST_BIDS_DEFAULT_LIMIT = 20;
/** Largest list_bids page. */
export const LIST_BIDS_MAX_LIMIT = 100;

export type TokenRef = { symbol: string; address: Address; decimals: number };

export function tokenRef(t: TokenInfo): TokenRef {
  return { symbol: t.symbol, address: t.address, decimals: t.decimals };
}

const isoTime = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** Pay token with that address among `tokens`, else a placeholder with 18 decimals. */
export function tokenOf(tokens: TokenInfo[], address: Address): TokenInfo {
  return tokens.find((t) => sameAddress(t.address, address)) ?? { address, symbol: "?", decimals: 18 };
}

/** One AmountView per entry of a per-token record, in insertion order. */
export function perToken(tokens: TokenInfo[], record: Record<Address, bigint>): AmountView[] {
  return Object.entries(record).map(([address, raw]) => amountView(raw, tokenOf(tokens, address as Address)));
}

export const listNetworksShape = {};

export async function listNetworks(ctx: ToolContext) {
  return {
    networks: ctx.chain.list().map(({ info, deployment }) => ({
      network: info.key,
      label: info.label,
      description: info.description,
      venue: info.venue,
      isFork: info.isFork,
      chainId: deployment?.chainId ?? info.chain.id,
      deployed: deployment !== null,
      contracts: deployment
        ? {
            market: deployment.market,
            receipt: deployment.receipt,
            underlying: deployment.underlying,
            selioVault: deployment.selioVault,
            collateralRoute: deployment.collateralRoute ?? null,
          }
        : null,
    })),
  };
}

export const getExitCapacityShape = { network: networkSchema };
export type GetExitCapacityArgs = z.infer<z.ZodObject<typeof getExitCapacityShape>>;

export async function getExitCapacity(ctx: ToolContext, args: GetExitCapacityArgs) {
  const h = ctx.chain.get(args.network);
  const [cap, underlying, bidLevels] = await Promise.all([
    h.sdk.capacity(),
    h.sdk.token(h.deployment.underlying),
    Promise.all(CAPACITY_DISCOUNT_LEVELS.map((d) => h.sdk.bidCapacityAt(d))),
  ]);
  return {
    network: args.network,
    underlying: tokenRef(underlying),
    withdrawableNow: amountView(cap.withdrawable, underlying),
    supplied: amountView(cap.supplied, underlying),
    utilization: bpsView(cap.utilizationBps),
    debtorCapacity: amountView(cap.debtorCapacity, underlying),
    sessionAssets: amountView(cap.sessionAssets, underlying),
    bidCapacity: CAPACITY_DISCOUNT_LEVELS.map((d, i) => ({
      maxDiscount: bpsView(d),
      assets: amountView(bidLevels[i] ?? 0n, underlying),
    })),
    notes: [
      "withdrawableNow: underlying the pool can pay out right now. debtorCapacity: same-asset debt that borrowers can repay by buying receipts.",
      "bidCapacity: receipt value that escrowed limit bids (including the Selio Vault) buy from a seller accepting up to that discount; only escrowed funds count.",
      "sessionAssets: receipt value currently offered in open Dutch-auction sessions.",
    ],
  };
}

export const listSessionsShape = {
  network: networkSchema,
  includeClosed: z
    .boolean()
    .optional()
    .describe("Include ended or fully sold sessions. Default false (open sessions only)."),
};
export type ListSessionsArgs = z.infer<z.ZodObject<typeof listSessionsShape>>;

export async function listSessions(ctx: ToolContext, args: ListSessionsArgs) {
  const h = ctx.chain.get(args.network);
  const [sessions, underlying, payTokens] = await Promise.all([
    h.sdk.sessions(!args.includeClosed),
    h.sdk.token(h.deployment.underlying),
    h.sdk.payTokens(),
  ]);
  return {
    network: args.network,
    sessions: sessions.map((s) => ({
      sessionId: s.id.toString(),
      seller: s.seller,
      open: s.open,
      currentDiscount: bpsView(s.discountBps),
      schedule: {
        start: bpsView(s.startBps),
        step: bpsView(s.stepBps),
        stepIntervalSeconds: s.stepInterval,
        cap: bpsView(s.capBps),
        startedAt: isoTime(s.startedAt),
        endsAt: isoTime(s.endsAt),
      },
      remaining: amountView(s.remainingAssets, underlying),
      acceptedPayTokens: payTokens
        .filter((t) => s.acceptedPayTokens.some((accepted) => sameAddress(accepted, t.address)))
        .map(tokenRef),
    })),
  };
}

export const listBidsShape = {
  network: networkSchema,
  cursor: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe("Where to continue: nextCursor from the previous list_bids call. Omit it for the first page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_BIDS_MAX_LIMIT)
    .optional()
    .describe(`Bids per page, at most ${LIST_BIDS_MAX_LIMIT}. Default ${LIST_BIDS_DEFAULT_LIMIT}.`),
};
export type ListBidsArgs = z.infer<z.ZodObject<typeof listBidsShape>>;

export async function listBids(ctx: ToolContext, args: ListBidsArgs) {
  const h = ctx.chain.get(args.network);
  const [bids, underlying, payTokens] = await Promise.all([
    h.sdk.bids(),
    h.sdk.token(h.deployment.underlying),
    h.sdk.payTokens(),
  ]);
  const offset = Number(args.cursor ?? "0");
  const limit = args.limit ?? LIST_BIDS_DEFAULT_LIMIT;
  const page = bids.slice(offset, offset + limit);
  return {
    network: args.network,
    total: bids.length,
    bids: page.map((b) => {
      const pay = payTokens[b.payIdx] ?? { address: b.payToken, symbol: "?", decimals: 18 };
      return {
        bidId: b.id.toString(),
        bidder: b.bidder,
        isSelioVault: sameAddress(b.bidder, h.deployment.selioVault),
        minDiscount: bpsView(b.minDiscountBps),
        payToken: tokenRef(pay),
        maxAssets: amountView(b.maxAssets, underlying),
        escrow: amountView(b.escrow, pay),
        buysUpTo: amountView(b.capacityAssets, underlying),
      };
    }),
    nextCursor: offset + limit < bids.length ? String(offset + limit) : null,
    notes: [
      "Bids are sorted best price for sellers first (lowest discount). buysUpTo is the receipt value the escrow still buys at the bid's own discount.",
      "This is one page of the book; pass nextCursor to read the next one. The book can change between calls, when bids fill or are cancelled, so a bid can move between pages.",
    ],
  };
}

export const quotePurchaseShape = {
  network: networkSchema,
  sessionId: idSchema.describe("Session id from list_sessions."),
  assets: amountSchema.describe('Receipt face value to buy, in the underlying asset (for example "1000" USDC).'),
  payToken: payTokenSchema,
};
export type QuotePurchaseArgs = z.infer<z.ZodObject<typeof quotePurchaseShape>>;

export async function quotePurchase(ctx: ToolContext, args: QuotePurchaseArgs) {
  const h = ctx.chain.get(args.network);
  const sessionId = toId(args.sessionId);
  const [s, underlying, pay] = await Promise.all([
    h.sdk.session(sessionId),
    h.sdk.token(h.deployment.underlying),
    resolvePayToken(h.sdk, args.payToken),
  ]);
  if (!s.open) throw new ToolError(`Session ${sessionId} is not open (ended, fully sold or unknown).`);
  if (!s.acceptedPayTokens.some((a) => sameAddress(a, pay.token.address))) {
    throw new ToolError(`Session ${sessionId} does not accept ${pay.token.symbol}.`);
  }
  const assets = parsePositiveAmount(args.assets, underlying.decimals, "assets");
  if (assets > s.remainingAssets) {
    throw new ToolError(
      `Session ${sessionId} only has ${formatUnits(s.remainingAssets, underlying.decimals)} ${underlying.symbol} left.`,
    );
  }
  const [price, feeBps] = await Promise.all([h.sdk.quote(assets, s.discountBps, pay.token.address), h.sdk.feeBps()]);
  const fee = await h.sdk.feeOf(price);
  const savings = (assets * BigInt(s.discountBps)) / BPS;
  return {
    network: args.network,
    sessionId: sessionId.toString(),
    currentDiscount: bpsView(s.discountBps),
    faceValue: amountView(assets, underlying),
    price: amountView(price, pay.token),
    savings: amountView(savings, underlying),
    fee: amountView(fee, pay.token),
    sellerNet: amountView(price - fee, pay.token),
    notes: [
      "A session's discount only rises over time, so waiting lowers the price but risks someone else buying first.",
      "Only borrowers with at least this much same-asset debt can buy; the debt is repaid by the face value. See get_borrower_position.",
      `Selio's fee is ${bpsView(feeBps).percent} of the price, rounded down; it comes out of what the seller receives, so the buyer pays the price.`,
    ],
  };
}

export const getBorrowerPositionShape = {
  network: networkSchema,
  address: addressSchema.describe("Borrower wallet address."),
};
export type GetBorrowerPositionArgs = z.infer<z.ZodObject<typeof getBorrowerPositionShape>>;

export async function getBorrowerPosition(ctx: ToolContext, args: GetBorrowerPositionArgs) {
  const h = ctx.chain.get(args.network);
  const address = toAddress(args.address, "address");
  const [pos, underlying] = await Promise.all([h.sdk.position(address), h.sdk.token(h.deployment.underlying)]);
  const hasDebt = pos.debt > 0n;
  const market = pos.market;
  const collateral = market && pos.collateral !== undefined ? pos.collateral : undefined;
  const collateralToken = market && collateral !== undefined ? await h.sdk.token(market.collateralToken) : undefined;
  return {
    network: args.network,
    address,
    debt: amountView(pos.debt, underlying),
    health: hasDebt && pos.health !== maxUint256 ? formatUnits(pos.health, 18) : null,
    healthMeaning:
      h.deployment.venue === "aave"
        ? "Aave health factor; liquidation below 1.0."
        : "Morpho max borrow over debt; liquidation below 1.0.",
    ...(collateralToken && collateral !== undefined
      ? {
          morphoMarketId: pos.marketId ?? null,
          collateral: amountView(collateral, collateralToken),
          collateralToken: tokenRef(collateralToken),
        }
      : {}),
    notes: [
      hasDebt
        ? `This borrower can buy up to ${formatUnits(pos.debt, underlying.decimals)} ${underlying.symbol} of receipts from a session and have that debt repaid in the same transaction (build_buy_and_repay, or build_buy_with_collateral to pay with freed collateral).`
        : `No ${underlying.symbol} debt on this market, so this address cannot buy from sessions; it can place limit bids or deposit into the Selio Vault instead.`,
    ],
  };
}

export const planSellNowShape = {
  network: networkSchema,
  assets: amountSchema.describe("Receipt face value to sell, in the underlying asset."),
  maxDiscountBps: discountBpsSchema.describe("Highest discount the seller accepts, in basis points (100 = 1%)."),
  payTokens: payTokensSchema,
};
export type PlanSellNowArgs = z.infer<z.ZodObject<typeof planSellNowShape>>;

export async function planSellNow(ctx: ToolContext, args: PlanSellNowArgs) {
  const h = ctx.chain.get(args.network);
  const [underlying, pay] = await Promise.all([
    h.sdk.token(h.deployment.underlying),
    resolvePayTokens(h.sdk, args.payTokens),
  ]);
  const assets = parsePositiveAmount(args.assets, underlying.decimals, "assets");
  const plan = await h.sdk.planSellNow(assets, args.maxDiscountBps, pay.mask);
  const [allTokens, feeBps] = await Promise.all([h.sdk.payTokens(), h.sdk.feeBps()]);
  const notes = [
    "Bids fill best price first, each at its own limit discount. Use build_sell_now with the same inputs to get the transaction.",
    `Each fill pays Selio's ${bpsView(feeBps).percent} fee out of its payment (rounded down); sellerNet is what the seller receives.`,
  ];
  if (plan.filledAssets < assets) {
    notes.push(
      "Escrowed bids cannot absorb the full amount; open a Dutch-auction session for the rest (build_open_session) so borrowers can buy it.",
    );
  }
  return {
    network: args.network,
    requested: amountView(assets, underlying),
    filled: amountView(plan.filledAssets, underlying),
    unfilled: amountView(assets - plan.filledAssets, underlying),
    averageDiscount: bpsView(plan.averageDiscountBps),
    fills: plan.fills.map((f) => {
      const token = tokenOf(allTokens, f.payToken);
      return {
        bidId: f.bidId.toString(),
        assets: amountView(f.assets, underlying),
        discount: bpsView(f.discountBps),
        pay: amountView(f.pay, token),
        fee: amountView(f.fee, token),
        sellerNet: amountView(f.sellerNet, token),
      };
    }),
    proceeds: perToken(allTokens, plan.proceeds),
    fees: perToken(allTokens, plan.fees),
    sellerNet: perToken(allTokens, plan.sellerNet),
    notes,
  };
}
