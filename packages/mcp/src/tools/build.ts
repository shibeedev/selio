import { decodeAbiParameters, encodeAbiParameters, formatUnits, parseSignature, zeroAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  BPS,
  morphoMarketId,
  type MorphoMarketParams,
  type RoutedSellPlan,
  type SellerQuote,
  type SessionView,
  type TokenInfo,
  type UnsignedTx,
} from "@selio/sdk";
import { amountView, bpsView, parseAmount, parsePositiveAmount } from "../amounts.js";
import type { BaseYieldState, NetworkHandle } from "../chain.js";
import { ToolError } from "../errors.js";
import { decodeRevert } from "../revert.js";
import {
  MAX_SESSION_SECONDS,
  addressSchema,
  amountSchema,
  discountBpsSchema,
  hexSchema,
  idSchema,
  networkSchema,
  payTokenSchema,
  payTokensSchema,
} from "../schemas.js";
import {
  amountFor,
  approvalIfNeeded,
  buildResult,
  optionalAddress,
  requireAave,
  resolvePayToken,
  resolvePayTokens,
  sameAddress,
  toAddress,
  toId,
  type BuildResult,
  type ResolvedPayToken,
  type ToolContext,
} from "./common.js";
import { kuruLegView, perToken, routeNotes, routedPlanFor, useKuruSchema } from "./read.js";

/** Default headroom on maxPay when the price depends on oracle prices (pay token is not the underlying). */
export const PRICE_BUFFER_BPS = 50n;
/** Lifetime of a Morpho flash-mode authorization signature. */
export const AUTH_DEADLINE_SECONDS = 3600n;
/** Default bound on how far the vault shares a deposit mints may fall below the current preview, in basis points. */
export const VAULT_DEPOSIT_SLIPPAGE_BPS = 50;

const MARKET_LABEL = "the Selio market";
const VAULT_RISK_NOTE =
  "Risk: capital that buys receipts stays in them until the pool is liquid again, and receipts lose value if the pool takes bad debt.";

const AUTH_TUPLE = {
  type: "tuple",
  components: [
    { name: "authorizer", type: "address" },
    { name: "authorized", type: "address" },
    { name: "isAuthorized", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const SIG_TUPLE = {
  type: "tuple",
  components: [
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
} as const;
const MARKET_PARAMS_TUPLE = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

const fromOptional = addressSchema
  .optional()
  .describe("Wallet that will sign. When given, an approval is only included if the current allowance is too low.");

const pct = (bps: number): string => bpsView(bps).percent;

/**
 * Vault V2 withdrawals pull from its liquidity market, so a buyer borrowing in another market needs a forced
 * deallocation, at a penalty. The liquidity market is the one the liquidity data encode, when the liquidity adapter
 * is the market's adapter; undecodable data counts as no liquidity market.
 */
export function isLiquidityMarket(
  liquidityAdapter: Address,
  liquidityData: Hex,
  marketAdapter: Address | undefined,
  market: MorphoMarketParams,
): boolean {
  if (!marketAdapter || !sameAddress(liquidityAdapter, marketAdapter) || liquidityData === "0x") return false;
  try {
    const [params] = decodeAbiParameters([MARKET_PARAMS_TUPLE], liquidityData);
    return morphoMarketId(params) === morphoMarketId(market);
  } catch {
    return false;
  }
}

async function venueDataFor(h: NetworkHandle, from: Address, market: MorphoMarketParams | undefined, auth?: Hex) {
  let force = false;
  if (h.deployment.venue !== "aave" && market) {
    const liquidity = await h.reads.morphoLiquidity();
    force = !isLiquidityMarket(liquidity.adapter, liquidity.data, h.deployment.adapter, market);
  }
  try {
    if (h.deployment.venue === "aave") return await h.sdk.venueData(from, auth ? { auth } : {});
    return await h.sdk.venueData(from, auth ? { auth, force } : { force });
  } catch (err) {
    if (err instanceof Error && /no (USDC|USDT0) debt/i.test(err.message)) {
      throw new ToolError(`${from} has no debt in the markets the Earn vault supplies, so it cannot buy.`);
    }
    throw err;
  }
}

export const buildOpenSessionShape = {
  network: networkSchema,
  from: fromOptional,
  assets: amountSchema.describe('Receipt face value to put up for sale, in the underlying asset (for example "10" USDC).'),
  startBps: discountBpsSchema.describe("Discount at the start, in basis points (100 = 1%)."),
  stepBps: discountBpsSchema.describe("Discount added every stepIntervalSeconds, in basis points."),
  stepIntervalSeconds: z.number().int().min(1).max(MAX_SESSION_SECONDS).describe("Seconds between discount steps."),
  capBps: discountBpsSchema.describe("Highest discount the session ever reaches, in basis points (contract max 5000)."),
  durationSeconds: z.number().int().min(1).max(MAX_SESSION_SECONDS).describe("Session length in seconds (max 30 days)."),
  payTokens: payTokensSchema,
};
export type BuildOpenSessionArgs = z.infer<z.ZodObject<typeof buildOpenSessionShape>>;

export async function buildOpenSession(ctx: ToolContext, args: BuildOpenSessionArgs): Promise<BuildResult> {
  if (args.startBps > args.capBps) throw new ToolError("startBps must not exceed capBps.");
  const h = ctx.chain.get(args.network);
  const from = optionalAddress(args.from, "from");
  const { deployment, sdk } = h;
  const [underlying, receipt, pay] = await Promise.all([
    sdk.token(deployment.underlying),
    sdk.token(deployment.receipt),
    resolvePayTokens(sdk, args.payTokens),
  ]);
  const assets = parsePositiveAmount(args.assets, underlying.decimals, "assets");
  const receiptAmount = await sdk.receiptAmountFor(assets);
  const approval = await approvalIfNeeded(sdk, receipt, from, deployment.market, receiptAmount, MARKET_LABEL);
  const open = sdk.openSession(receiptAmount, {
    startBps: args.startBps,
    stepBps: args.stepBps,
    stepInterval: args.stepIntervalSeconds,
    capBps: args.capBps,
    duration: args.durationSeconds,
    payMask: pay.mask,
  });
  const [atStart, atCap, feeBps] = await Promise.all([
    sdk.sellerQuote(assets, args.startBps, underlying.address),
    sdk.sellerQuote(assets, args.capBps, underlying.address),
    sdk.feeBps(),
  ]);
  const notes = [
    ...approval.notes,
    `The discount starts at ${pct(args.startBps)}, rises by ${pct(args.stepBps)} every ${args.stepIntervalSeconds}s up to ${pct(args.capBps)}, and the session ends after ${args.durationSeconds}s. It never decreases.`,
    "Borrowers of the same asset, limit bids and the Selio Vault can buy from the session; the seller is paid in the same transaction as each purchase.",
    `Each purchase or match pays the seller its price minus Selio's ${pct(feeBps)} fee (rounded down), taken in the asset that fill pays in. Sold all at once in ${underlying.symbol}, the session would pay the seller ${formatUnits(atStart.sellerNet, underlying.decimals)} after the fee at the start discount and ${formatUnits(atCap.sellerNet, underlying.decimals)} at the cap.`,
    "Unsold receipts can be taken back at any time with build_withdraw_unsold.",
  ];
  if (deployment.venue === "morpho") {
    notes.push(
      "Morpho receipts are vault shares: receiptAmount is the share amount worth the requested assets at the current share price.",
    );
  }
  const terms = (q: SellerQuote) => ({
    payment: amountView(q.payment, underlying),
    fee: amountView(q.fee, underlying),
    sellerNet: amountView(q.sellerNet, underlying),
  });
  return buildResult(h, args.network, [...approval.transactions, open], notes, {
    assets: amountView(assets, underlying),
    receiptAmount: amountView(receiptAmount, receipt),
    acceptedPayTokens: pay.tokens.map((t) => t.symbol),
    feeRate: bpsView(feeBps),
    atStart: terms(atStart),
    atCap: terms(atCap),
  });
}

export const buildWithdrawUnsoldShape = {
  network: networkSchema,
  sessionId: idSchema.describe("Session id from list_sessions."),
  from: addressSchema.optional().describe("Seller wallet; when given, it must be the session's seller."),
};
export type BuildWithdrawUnsoldArgs = z.infer<z.ZodObject<typeof buildWithdrawUnsoldShape>>;

export async function buildWithdrawUnsold(ctx: ToolContext, args: BuildWithdrawUnsoldArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const sessionId = toId(args.sessionId);
  const [session, underlying] = await Promise.all([h.sdk.session(sessionId), h.sdk.token(h.deployment.underlying)]);
  if (sameAddress(session.seller, zeroAddress)) throw new ToolError(`Session ${sessionId} does not exist.`);
  if (args.from !== undefined && !sameAddress(args.from, session.seller)) {
    throw new ToolError(`Only the seller ${session.seller} can withdraw from session ${sessionId}.`);
  }
  if (session.units === 0n) throw new ToolError(`Session ${sessionId} has no unsold receipts left.`);
  return buildResult(
    h,
    args.network,
    [h.sdk.withdrawUnsold(sessionId)],
    [
      `Send from the seller's wallet ${session.seller}. All unsold receipts return immediately; parts already sold are not affected.`,
    ],
    { sessionId: sessionId.toString(), unsold: amountView(session.remainingAssets, underlying) },
  );
}

export const buildBuyAndRepayShape = {
  network: networkSchema,
  sessionId: idSchema.describe("Session id from list_sessions."),
  assets: amountSchema.describe("Receipt face value to buy, in the underlying asset; this much of the buyer's debt is repaid."),
  payToken: payTokenSchema,
  from: addressSchema.describe("Borrower wallet that buys and signs; must owe at least `assets` of the same asset."),
  maxPay: amountSchema
    .optional()
    .describe(
      "Most the buyer will pay, in the pay token. Defaults to the current quote (plus 0.5% when the pay token is oracle-priced).",
    ),
};
export type BuildBuyAndRepayArgs = z.infer<z.ZodObject<typeof buildBuyAndRepayShape>>;

interface PreparedBuy {
  sessionId: bigint;
  session: SessionView;
  underlying: TokenInfo;
  pay: ResolvedPayToken;
  assets: bigint;
  price: bigint;
  fee: bigint;
  sellerNet: bigint;
  maxPay: bigint;
  debt: bigint;
  /** Morpho only: the market the buyer owes in. */
  market?: MorphoMarketParams;
}

async function prepareBuy(
  h: NetworkHandle,
  args: { sessionId: number | string; assets: string; payToken: string; maxPay?: string },
  from: Address,
): Promise<PreparedBuy> {
  const { sdk, deployment } = h;
  const sessionId = toId(args.sessionId);
  const [session, underlying, pay, position] = await Promise.all([
    sdk.session(sessionId),
    sdk.token(deployment.underlying),
    resolvePayToken(sdk, args.payToken),
    sdk.position(from),
  ]);
  if (!session.open) throw new ToolError(`Session ${sessionId} is not open (ended, fully sold or unknown).`);
  if (!session.acceptedPayTokens.some((a) => sameAddress(a, pay.token.address))) {
    throw new ToolError(`Session ${sessionId} does not accept ${pay.token.symbol}.`);
  }
  const assets = parsePositiveAmount(args.assets, underlying.decimals, "assets");
  if (assets > session.remainingAssets) {
    throw new ToolError(
      `Session ${sessionId} only has ${formatUnits(session.remainingAssets, underlying.decimals)} ${underlying.symbol} left.`,
    );
  }
  if (position.debt < assets) {
    throw new ToolError(
      `${from} owes ${formatUnits(position.debt, underlying.decimals)} ${underlying.symbol}, less than the ${args.assets} ${underlying.symbol} requested; buyers must have at least that much same-asset debt.`,
    );
  }
  const price = await sdk.quote(assets, session.discountBps, pay.token.address);
  const fee = await sdk.feeOf(price);
  let maxPay: bigint;
  if (args.maxPay !== undefined) {
    maxPay = parsePositiveAmount(args.maxPay, pay.token.decimals, "maxPay");
    if (maxPay < price) {
      throw new ToolError(
        `maxPay ${args.maxPay} ${pay.token.symbol} is below the current price ${formatUnits(price, pay.token.decimals)} ${pay.token.symbol}.`,
      );
    }
  } else if (sameAddress(pay.token.address, deployment.underlying)) {
    maxPay = price;
  } else {
    maxPay = price + (price * PRICE_BUFFER_BPS + BPS - 1n) / BPS;
  }
  return {
    sessionId,
    session,
    underlying,
    pay,
    assets,
    price,
    fee,
    sellerNet: price - fee,
    maxPay,
    debt: position.debt,
    ...(position.market ? { market: position.market } : {}),
  };
}

function maxPayNote(p: PreparedBuy, explicit: boolean): string[] {
  if (explicit || p.maxPay === p.price) return [];
  return [
    `maxPay includes a ${Number(PRICE_BUFFER_BPS) / 100}% buffer over the quoted price because ${p.pay.token.symbol} is priced through oracles; you pay the price at execution, never more than maxPay.`,
  ];
}

function buyDetails(p: PreparedBuy) {
  return {
    sessionId: p.sessionId.toString(),
    currentDiscount: bpsView(p.session.discountBps),
    faceValue: amountView(p.assets, p.underlying),
    price: amountView(p.price, p.pay.token),
    maxPay: amountView(p.maxPay, p.pay.token),
    savings: amountView((p.assets * BigInt(p.session.discountBps)) / BPS, p.underlying),
    debtBefore: amountView(p.debt, p.underlying),
    fee: amountView(p.fee, p.pay.token),
    sellerNet: amountView(p.sellerNet, p.pay.token),
  };
}

export async function buildBuyAndRepay(ctx: ToolContext, args: BuildBuyAndRepayArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const from = toAddress(args.from, "from");
  const p = await prepareBuy(h, args, from);
  const venueData = await venueDataFor(h, from, p.market);
  const approval = await approvalIfNeeded(h.sdk, p.pay.token, from, h.deployment.market, p.maxPay, MARKET_LABEL);
  const buy = h.sdk.buyAndRepay(p.sessionId, p.assets, p.pay.index, p.maxPay, venueData);
  return buildResult(
    h,
    args.network,
    [...approval.transactions, buy],
    [
      ...approval.notes,
      ...maxPayNote(p, args.maxPay !== undefined),
      "In one transaction the market repays the buyer's debt by the face value bought (minus any flash-loan fee), pays the seller from the buyer's wallet (the seller receives the price minus Selio's 0.2% fee), and leaves the pool's withdrawable liquidity unchanged. If any step fails, nothing happens.",
    ],
    buyDetails(p),
  );
}

export const buildBuyWithCollateralShape = {
  ...buildBuyAndRepayShape,
  payToken: payTokenSchema.describe(
    "Collateral token that pays the seller (not the underlying). Aave: a pay token with an Aave aToken the buyer holds as collateral. Morpho: the collateral token of the buyer's market.",
  ),
  maxPay: amountSchema.optional().describe("Most collateral to give up, in the pay token. Defaults to the current quote plus 0.5%."),
  authorization: z
    .object({
      nonce: z.string().regex(/^\d+$/).describe("Nonce from the typed data that was signed."),
      deadline: z.string().regex(/^\d+$/).describe("Deadline from the typed data that was signed."),
      grantSignature: hexSchema.describe("Buyer's EIP-712 signature of the grant message."),
      revokeSignature: hexSchema.describe("Buyer's EIP-712 signature of the revoke message."),
    })
    .optional()
    .describe(
      "Morpho only, second step: the two signatures returned by the buyer's wallet for the typed data of the first call.",
    ),
};
export type BuildBuyWithCollateralArgs = z.infer<z.ZodObject<typeof buildBuyWithCollateralShape>>;

function splitSignature(sig: Hex, field: string): { v: number; r: Hex; s: Hex } {
  try {
    const { r, s, v, yParity } = parseSignature(sig);
    return { v: Number(v ?? BigInt(27 + (yParity ?? 0))), r, s };
  } catch {
    throw new ToolError(`${field} is not a valid 65-byte signature.`);
  }
}

export async function buildBuyWithCollateral(ctx: ToolContext, args: BuildBuyWithCollateralArgs) {
  const h = ctx.chain.get(args.network);
  const { deployment, sdk } = h;
  const from = toAddress(args.from, "from");
  const p = await prepareBuy(h, args, from);
  if (sameAddress(p.pay.token.address, deployment.underlying)) {
    throw new ToolError(
      `Flash mode pays the seller with freed collateral, so the pay token cannot be the underlying ${p.underlying.symbol}. Use build_buy_and_repay to pay from the wallet.`,
    );
  }
  const baseNotes = [
    ...maxPayNote(p, args.maxPay !== undefined),
    "Flash mode needs no cash: the market repays the debt first, then pays the seller with collateral the repayment frees. The buyer's health can only improve; otherwise the transaction reverts.",
  ];

  if (deployment.venue === "aave") {
    const aTokenAddress = deployment.payATokens?.[p.pay.index];
    if (!aTokenAddress || sameAddress(aTokenAddress, zeroAddress)) {
      throw new ToolError(`${p.pay.token.symbol} has no Aave collateral aToken on this market; choose another pay token.`);
    }
    // The market pulls a few extra aToken wei for Aave rounding and refunds what it does not use.
    const [aToken, margin] = await Promise.all([
      sdk.token(aTokenAddress),
      sdk.collateralPullMargin(p.pay.token.address),
    ]);
    const approval = await approvalIfNeeded(sdk, aToken, from, deployment.market, p.maxPay + margin, MARKET_LABEL);
    const buy = sdk.buyAndRepayWithCollateral(p.sessionId, p.assets, p.pay.index, p.maxPay, "0x");
    return buildResult(
      h,
      args.network,
      [...approval.transactions, buy],
      [
        ...approval.notes,
        ...baseNotes,
        `The buyer approves the market once for ${aToken.symbol}; the market withdraws only the collateral that pays the seller. This fails if the ${p.pay.token.symbol} pool is itself frozen; then use build_buy_and_repay.`,
      ],
      { ...buyDetails(p), collateralAToken: { symbol: aToken.symbol, address: aToken.address } },
    );
  }

  const market = p.market;
  if (!market) throw new ToolError(`${from} has no debt in the markets the Earn vault supplies.`);
  if (!sameAddress(market.collateralToken, p.pay.token.address)) {
    const collateral = await sdk.token(market.collateralToken);
    throw new ToolError(`The buyer's Morpho collateral is ${collateral.symbol}; use it as payToken.`);
  }
  const morpho = deployment.morpho;
  if (!morpho) throw new ToolError("This network has no Morpho deployment.");
  const currentNonce = await h.reads.morphoNonce(from);

  const auth = args.authorization;
  if (!auth) {
    const latest = await h.reads.latestTimestamp();
    const now = ctx.nowSeconds?.() ?? BigInt(Math.floor(Date.now() / 1000));
    const deadline = (latest > now ? latest : now) + AUTH_DEADLINE_SECONDS;
    const typedData = (isAuthorized: boolean, nonce: bigint) => ({
      domain: { chainId: deployment.chainId, verifyingContract: morpho },
      types: {
        EIP712Domain: [
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Authorization: [
          { name: "authorizer", type: "address" },
          { name: "authorized", type: "address" },
          { name: "isAuthorized", type: "bool" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Authorization",
      message: {
        authorizer: from,
        authorized: deployment.market,
        isAuthorized,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
    });
    return {
      network: args.network,
      chainId: deployment.chainId,
      transactions: [],
      signatureRequests: [
        {
          name: "grant",
          purpose: "Lets the market withdraw the freed collateral during the purchase.",
          typedData: typedData(true, currentNonce),
        },
        {
          name: "revoke",
          purpose: "Removes that permission again inside the same transaction.",
          typedData: typedData(false, currentNonce + 1n),
        },
      ],
      notes: [
        ...baseNotes,
        "On Morpho, flash mode needs two EIP-712 signatures from the buyer instead of an approval transaction. Selio never signs: ask the buyer's wallet to sign both typed data objects (eth_signTypedData_v4), in this order.",
        `Then call build_buy_with_collateral again with the same inputs plus authorization {nonce: "${currentNonce}", deadline: "${deadline}", grantSignature, revokeSignature} to get the transaction. The signatures expire at the deadline and become invalid if the buyer signs another Morpho authorization first.`,
      ],
      details: buyDetails(p),
    };
  }

  const nonce = BigInt(auth.nonce);
  const deadline = BigInt(auth.deadline);
  if (nonce !== currentNonce) {
    throw new ToolError(
      `The signatures were made for Morpho nonce ${nonce}, but the buyer's nonce is now ${currentNonce}. Request new typed data.`,
    );
  }
  if (deadline <= (await h.reads.latestTimestamp())) {
    throw new ToolError("The signed authorization has expired. Request new typed data.");
  }
  const grant = { authorizer: from, authorized: deployment.market, isAuthorized: true, nonce, deadline };
  const revoke = { ...grant, isAuthorized: false, nonce: nonce + 1n };
  const encoded = encodeAbiParameters(
    [AUTH_TUPLE, SIG_TUPLE, AUTH_TUPLE, SIG_TUPLE],
    [
      grant,
      splitSignature(auth.grantSignature as Hex, "grantSignature"),
      revoke,
      splitSignature(auth.revokeSignature as Hex, "revokeSignature"),
    ],
  );
  const venueData = await venueDataFor(h, from, market, encoded);
  const buy = sdk.buyAndRepayWithCollateral(p.sessionId, p.assets, p.pay.index, p.maxPay, venueData);
  return buildResult(
    h,
    args.network,
    [buy],
    [...baseNotes, "The signed grant is used and revoked inside this transaction, so no permission survives it."],
    buyDetails(p),
  );
}

export const buildPlaceBidShape = {
  network: networkSchema,
  from: fromOptional,
  minDiscountBps: discountBpsSchema.describe("Lowest discount at which the bid may fill, in basis points (100 = 1%)."),
  payToken: payTokenSchema,
  maxAssets: amountSchema.describe("Most receipt face value to buy, in the underlying asset."),
  escrow: amountSchema.describe("Pay-token amount to escrow now; the bid is only live for what is escrowed."),
};
export type BuildPlaceBidArgs = z.infer<z.ZodObject<typeof buildPlaceBidShape>>;

export async function buildPlaceBid(ctx: ToolContext, args: BuildPlaceBidArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const { deployment, sdk } = h;
  const from = optionalAddress(args.from, "from");
  const [underlying, pay] = await Promise.all([sdk.token(deployment.underlying), resolvePayToken(sdk, args.payToken)]);
  const maxAssets = parsePositiveAmount(args.maxAssets, underlying.decimals, "maxAssets");
  const escrow = parsePositiveAmount(args.escrow, pay.token.decimals, "escrow");
  const [fullCost, approval] = await Promise.all([
    sdk.quote(maxAssets, args.minDiscountBps, pay.token.address),
    approvalIfNeeded(sdk, pay.token, from, deployment.market, escrow, MARKET_LABEL),
  ]);
  const bid = sdk.placeBid(args.minDiscountBps, pay.index, maxAssets, escrow);
  const notes = [
    ...approval.notes,
    `The bid never fills below ${pct(args.minDiscountBps)} discount. Lower-discount bids fill first. Cancel at any time with build_cancel_bid to get unused escrow back immediately.`,
    "Bought receipts go to the bidder, who redeems the underlying once the pool is liquid again; the profit is the discount plus the receipt's interest.",
  ];
  if (escrow < fullCost) {
    notes.push(
      `The escrow covers only part of maxAssets at the limit price (${formatUnits(fullCost, pay.token.decimals)} ${pay.token.symbol} would cover all of it).`,
    );
  }
  return buildResult(h, args.network, [...approval.transactions, bid], notes, {
    minDiscount: bpsView(args.minDiscountBps),
    maxAssets: amountView(maxAssets, underlying),
    escrow: amountView(escrow, pay.token),
    escrowForFullFill: amountView(fullCost, pay.token),
  });
}

export const buildCancelBidShape = {
  network: networkSchema,
  bidId: idSchema.describe("Bid id from list_bids."),
  from: addressSchema.optional().describe("Bidder wallet; when given, it must be the bid's owner."),
};
export type BuildCancelBidArgs = z.infer<z.ZodObject<typeof buildCancelBidShape>>;

export async function buildCancelBid(ctx: ToolContext, args: BuildCancelBidArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const bidId = toId(args.bidId);
  const [bids, payTokens] = await Promise.all([h.sdk.bids(), h.sdk.payTokens()]);
  const bid = bids.find((b) => b.id === bidId);
  if (!bid) throw new ToolError(`Bid ${bidId} is not active (filled, cancelled or unknown).`);
  if (args.from !== undefined && !sameAddress(args.from, bid.bidder)) {
    throw new ToolError(`Only the bidder ${bid.bidder} can cancel bid ${bidId}.`);
  }
  const payToken = payTokens[bid.payIdx] ?? { symbol: "?", decimals: 18 };
  return buildResult(
    h,
    args.network,
    [h.sdk.cancelBid(bidId)],
    [`Send from the bidder's wallet ${bid.bidder}. The unused escrow is refunded in the same transaction.`],
    { bidId: bidId.toString(), refund: amountView(bid.escrow, payToken) },
  );
}

export const buildSellNowShape = {
  network: networkSchema,
  from: fromOptional,
  assets: amountSchema.describe("Receipt face value to sell, in the underlying asset."),
  maxDiscountBps: discountBpsSchema.describe("Highest discount the seller accepts, in basis points (100 = 1%)."),
  payTokens: payTokensSchema,
  minFilled: amountSchema
    .optional()
    .describe("Revert unless at least this much face value sells. Defaults to the amount the current bids can absorb."),
  useKuru: useKuruSchema,
};
export type BuildSellNowArgs = z.infer<z.ZodObject<typeof buildSellNowShape>>;

export async function buildSellNow(ctx: ToolContext, args: BuildSellNowArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const { deployment, sdk } = h;
  const from = optionalAddress(args.from, "from");
  const [underlying, receipt, pay, allTokens] = await Promise.all([
    sdk.token(deployment.underlying),
    sdk.token(deployment.receipt),
    resolvePayTokens(sdk, args.payTokens),
    sdk.payTokens(),
  ]);
  const assets = parsePositiveAmount(args.assets, underlying.decimals, "assets");
  const routed = await routedPlanFor(h, args.useKuru, assets, args.maxDiscountBps, pay.mask);
  if (routed?.kuru) return buildRoutedSell(h, args, routed, { from, assets, underlying, receipt, allTokens });
  const plan = routed ? routed.selio : await sdk.planSellNow(assets, args.maxDiscountBps, pay.mask);
  if (plan.filledAssets === 0n) {
    throw new ToolError(
      `No escrowed bid buys at or below ${pct(args.maxDiscountBps)} in ${pay.tokens.map((t) => t.symbol).join("/")}. Raise maxDiscountBps or open a session with build_open_session.`,
    );
  }
  const minFilled =
    args.minFilled === undefined ? plan.filledAssets : parseAmount(args.minFilled, underlying.decimals, "minFilled");
  if (minFilled > plan.filledAssets) {
    throw new ToolError(
      `Current bids can only absorb ${formatUnits(plan.filledAssets, underlying.decimals)} ${underlying.symbol}, below minFilled.`,
    );
  }
  // Morpho moves shares per fill, each rounded up, so allow one share unit of slack per fill.
  const receiptAmount =
    deployment.venue === "aave"
      ? plan.filledAssets
      : (await sdk.receiptAmountFor(plan.filledAssets)) + BigInt(plan.fills.length);
  const [approval, feeBps] = await Promise.all([
    approvalIfNeeded(sdk, receipt, from, deployment.market, receiptAmount, MARKET_LABEL),
    sdk.feeBps(),
  ]);
  const sell = sdk.sellNow(plan, args.maxDiscountBps, pay.mask, minFilled);
  const notes = [
    ...approval.notes,
    "Each bid fills at its own limit discount, best price first; proceeds reach the seller in the same transaction.",
    `Selio takes ${pct(feeBps)} of each fill's payment as its fee; the seller receives sellerNet.`,
  ];
  if (plan.filledAssets < assets) {
    notes.push(
      `Only ${formatUnits(plan.filledAssets, underlying.decimals)} of ${args.assets} ${underlying.symbol} can be sold into bids now; open a session for the rest with build_open_session.`,
    );
  }
  return buildResult(h, args.network, [...approval.transactions, sell], notes, {
    filled: amountView(plan.filledAssets, underlying),
    minFilled: amountView(minFilled, underlying),
    averageDiscount: bpsView(plan.averageDiscountBps),
    bidIds: plan.bidIds.map((id) => id.toString()),
    proceeds: perToken(allTokens, plan.proceeds),
    fees: perToken(allTokens, plan.fees),
    sellerNet: perToken(allTokens, plan.sellerNet),
    ...(routed ? { route: routed.route } : {}),
  });
}

/** Sell now through KuruSellRouter: the Selio part into escrowed bids and the Kuru part on the order book, atomically. */
async function buildRoutedSell(
  h: NetworkHandle,
  args: BuildSellNowArgs,
  plan: RoutedSellPlan,
  t: { from: Address | undefined; assets: bigint; underlying: TokenInfo; receipt: TokenInfo; allTokens: TokenInfo[] },
): Promise<BuildResult> {
  const { deployment, sdk } = h;
  const router = deployment.kuruSellRouter as Address;
  if (args.minFilled !== undefined) {
    const minFilled = parseAmount(args.minFilled, t.underlying.decimals, "minFilled");
    if (minFilled > plan.filledAssets) {
      throw new ToolError(
        `Selio's bids and the Kuru book can only absorb ${formatUnits(plan.filledAssets, t.underlying.decimals)} ${t.underlying.symbol}, below minFilled.`,
      );
    }
  }
  const kuru = await kuruLegView(h, plan.kuru as NonNullable<RoutedSellPlan["kuru"]>);
  const [amount, feeBps] = await Promise.all([sdk.routedSellApproval(plan), sdk.feeBps()]);
  const approval = await approvalIfNeeded(sdk, t.receipt, t.from, router, amount, "the Kuru sell router");
  const sell = sdk.routedSell(plan, t.from ?? zeroAddress);
  const notes = [
    ...approval.notes,
    ...routeNotes(plan, kuru.takerFeeBps),
    `The Selio part must fill exactly as planned and the Kuru part pay at least ${kuru.minOut.human} ${t.underlying.symbol}; proceeds and anything unsold return to ${t.from ?? "the sender"} in the same transaction.`,
    `Selio takes ${pct(feeBps)} of each Selio fill's payment as its fee; sellerNet is the Selio part the seller receives, kuru.expectedOut the Kuru part.`,
  ];
  if (plan.filledAssets < t.assets) {
    notes.push(
      `Only ${formatUnits(plan.filledAssets, t.underlying.decimals)} of ${args.assets} ${t.underlying.symbol} can be sold now; open a session for the rest with build_open_session.`,
    );
  }
  return buildResult(h, args.network, [...approval.transactions, sell], notes, {
    route: plan.route,
    filled: amountView(plan.filledAssets, t.underlying),
    averageDiscount: bpsView(plan.averageDiscountBps),
    bidIds: plan.selio.bidIds.map((id) => id.toString()),
    proceeds: perToken(t.allTokens, plan.selio.proceeds),
    fees: perToken(t.allTokens, plan.selio.fees),
    sellerNet: perToken(t.allTokens, plan.selio.sellerNet),
    kuru,
    router,
  });
}

/** The vault's base-yield position (Part 0 §0.13) with the source's share token, or null when it has no yield source. */
async function baseYieldState(h: NetworkHandle) {
  const state = await h.reads.vaultBaseYield();
  return state ? { ...state, token: await h.sdk.token(state.source) } : null;
}

function baseYieldView(y: BaseYieldState & { token: TokenInfo }, asset: TokenInfo) {
  return {
    source: y.source,
    symbol: y.token.symbol,
    sourceAssets: amountView(y.sourceAssets, asset),
    sourceShares: amountView(y.sourceShares, y.token),
    sourceUtilization: bpsView(y.sourceUtilizationBps),
  };
}

export const buildVaultDepositShape = {
  network: networkSchema,
  from: fromOptional,
  assets: amountSchema.describe("Amount of the vault asset to deposit."),
  receiver: addressSchema.optional().describe("Who receives the vault shares. Defaults to `from`."),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      `Most the minted shares may fall below the current preview, in basis points (100 = 1%). Default ${VAULT_DEPOSIT_SLIPPAGE_BPS}.`,
    ),
};
export type BuildVaultDepositArgs = z.infer<z.ZodObject<typeof buildVaultDepositShape>>;

export async function buildVaultDeposit(ctx: ToolContext, args: BuildVaultDepositArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const { deployment, sdk } = h;
  const from = optionalAddress(args.from, "from");
  const receiver = optionalAddress(args.receiver, "receiver") ?? from;
  if (!receiver) throw new ToolError("Pass `receiver` or `from` so the vault knows who gets the shares.");
  const asset = await sdk.token(await h.reads.vaultAsset());
  const assets = parsePositiveAmount(args.assets, asset.decimals, "assets");
  const approval = await approvalIfNeeded(sdk, asset, from, deployment.selioVault, assets, "the Selio Vault");
  const [preview, shareToken, source] = await Promise.all([
    sdk.vaultPreviewDeposit(assets),
    sdk.token(deployment.selioVault),
    baseYieldState(h),
  ]);
  const slippageBps = args.slippageBps ?? VAULT_DEPOSIT_SLIPPAGE_BPS;
  const minShares = (preview * BigInt(10_000 - slippageBps)) / 10_000n;
  const deposit = sdk.vaultDeposit(assets, receiver, minShares);
  return buildResult(
    h,
    args.network,
    [...approval.transactions, deposit],
    [
      ...approval.notes,
      "The vault keeps idle capital outside the protected pool and escrows it as limit bids at its minimum discount; deposits re-size those bids in the same transaction.",
      VAULT_RISK_NOTE,
      `The deposit reverts if it would mint fewer than ${formatUnits(minShares, shareToken.decimals)} vault shares: the current preview minus ${pct(slippageBps)}.`,
    ],
    {
      vault: deployment.selioVault,
      deposit: amountView(assets, asset),
      receiver,
      expectedShares: amountView(preview, shareToken),
      minShares: amountView(minShares, shareToken),
      baseYield: source ? baseYieldView(source, asset) : null,
    },
  );
}

export const buildVaultRedeemShape = {
  network: networkSchema,
  from: addressSchema.describe("Share owner, who signs the redemption."),
  shares: amountSchema.optional().describe("Vault shares to redeem (human units). Defaults to all shares of `from`."),
  receiver: addressSchema.optional().describe("Who receives the assets and receipts. Defaults to `from`."),
  skip: z
    .array(addressSchema)
    .optional()
    .describe(
      "Receipt tokens to leave in the vault because they cannot be transferred right now (for example a paused reserve); their part stays claimable later by the same holder.",
    ),
};
export type BuildVaultRedeemArgs = z.infer<z.ZodObject<typeof buildVaultRedeemShape>>;

export async function buildVaultRedeem(ctx: ToolContext, args: BuildVaultRedeemArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  const { deployment, sdk } = h;
  const from = toAddress(args.from, "from");
  const receiver = optionalAddress(args.receiver, "receiver") ?? from;
  const [shareToken, receipt, assetAddress] = await Promise.all([
    sdk.token(deployment.selioVault),
    sdk.token(deployment.receipt),
    h.reads.vaultAsset(),
  ]);
  const shares =
    args.shares === undefined
      ? await sdk.balanceOf(deployment.selioVault, from)
      : parsePositiveAmount(args.shares, shareToken.decimals, "shares");
  if (shares === 0n) throw new ToolError(`${from} holds no Selio Vault shares.`);
  const skip = (args.skip ?? []).map((a) => toAddress(a, "skip"));
  for (const a of skip) {
    if (!sameAddress(a, deployment.receipt)) {
      throw new ToolError(`${a} is not a receipt the Selio Vault holds; skip accepts ${receipt.symbol} (${deployment.receipt}).`);
    }
  }
  const [asset, preview, source] = await Promise.all([
    sdk.token(assetAddress),
    h.reads.vaultPreviewRedeem(shares),
    baseYieldState(h),
  ]);
  const redeem = sdk.vaultRedeem(shares, receiver, from, skip);
  const notes = [
    `Send from ${from}. Redemption works at any time: idle capital comes back in ${asset.symbol} now, the share of receipts the vault holds comes back in kind (${receipt.symbol}).`,
  ];
  if (skip.length > 0) notes.push(`The receipts listed in skip stay in the vault; their part stays claimable later by ${from}.`);
  if (source && preview.sourceSharesInKind > 0n) {
    notes.push(
      `The yield source cannot pay all of its part now, so ${formatUnits(preview.sourceSharesInKind, source.token.decimals)} ${source.token.symbol} (the source's own shares) come back in kind.`,
    );
  }
  return buildResult(h, args.network, [redeem], notes, {
    shares: amountView(shares, shareToken),
    receiveNow: amountView(preview.assets, asset),
    receiveInKind: amountView(preview.receipts[0] ?? 0n, receipt),
    receiver,
    ...(skip.length > 0 ? { skipped: skip } : {}),
    baseYield: source
      ? { ...baseYieldView(source, asset), sourceSharesInKind: amountView(preview.sourceSharesInKind, source.token) }
      : null,
  });
}

export const buildRouteRepayShape = {
  network: networkSchema,
  from: addressSchema.describe("Aave borrower whose collateral is the market's frozen aToken (for example aMonUSDT0)."),
  collateralAmount: amountSchema.describe("Most frozen aToken collateral to sell, in aToken units (same as the underlying)."),
  repayToken: payTokenSchema.describe("Debt asset to repay; must be a market pay token that the borrower owes on Aave."),
  repayAmount: amountSchema.describe("Debt to repay, in repayToken units."),
  maxDiscountBps: discountBpsSchema.describe("Highest discount accepted when selling the collateral into bids."),
  minProceeds: amountSchema
    .optional()
    .describe(
      "Least the collateral sale must raise after Selio's 0.2% fee, in repayToken units; the route reverts below it. Defaults to repayAmount.",
    ),
};
export type BuildRouteRepayArgs = z.infer<z.ZodObject<typeof buildRouteRepayShape>>;

export async function buildRouteRepayWithFrozenCollateral(ctx: ToolContext, args: BuildRouteRepayArgs): Promise<BuildResult> {
  const h = ctx.chain.get(args.network);
  requireAave(h, "build_route_repay_with_frozen_collateral");
  const { deployment, sdk } = h;
  const route = deployment.collateralRoute;
  if (!route) throw new ToolError("This network has no frozen-collateral route deployed.");
  const from = toAddress(args.from, "from");
  const [receipt, underlying, pay, cap] = await Promise.all([
    sdk.token(deployment.receipt),
    sdk.token(deployment.underlying),
    resolvePayToken(sdk, args.repayToken),
    sdk.capacity(),
  ]);
  const collateral = parsePositiveAmount(args.collateralAmount, receipt.decimals, "collateralAmount");
  const repay = parsePositiveAmount(args.repayAmount, pay.token.decimals, "repayAmount");
  const minProceeds =
    args.minProceeds === undefined ? repay : parsePositiveAmount(args.minProceeds, pay.token.decimals, "minProceeds");
  if (cap.withdrawable >= collateral) {
    throw new ToolError(
      `The pool can pay out ${formatUnits(cap.withdrawable, underlying.decimals)} ${underlying.symbol} now, so the collateral can be withdrawn directly. The fallback route is only for collateral that cannot be withdrawn.`,
    );
  }
  const plan = await sdk.planSellNow(collateral, args.maxDiscountBps, 1 << pay.index);
  // The route sells as the seller, so it receives the proceeds net of Selio's fee.
  const proceeds = amountFor(plan.sellerNet, pay.token.address);
  const fee = amountFor(plan.fees, pay.token.address);
  if (plan.filledAssets === 0n) {
    throw new ToolError(`No escrowed bid pays in ${pay.token.symbol} at or below ${pct(args.maxDiscountBps)} discount.`);
  }
  if (proceeds < repay) {
    throw new ToolError(
      `Selling ${args.collateralAmount} ${receipt.symbol} into current bids yields about ${formatUnits(proceeds, pay.token.decimals)} ${pay.token.symbol}, less than repayAmount.`,
    );
  }
  if (proceeds < minProceeds) {
    throw new ToolError(
      `Current bids pay about ${formatUnits(proceeds, pay.token.decimals)} ${pay.token.symbol}, less than minProceeds.`,
    );
  }
  const approval = await approvalIfNeeded(sdk, receipt, from, route, collateral, "the Selio collateral route");
  const tx: UnsignedTx = sdk.routeRepayWithFrozenCollateral(
    collateral,
    plan,
    args.maxDiscountBps,
    pay.index,
    repay,
    minProceeds,
  );
  const notes = [
    ...approval.notes,
    "The route repays the debt first with an Aave flash loan, sells the frozen collateral into escrowed bids to cover it (plus Aave's flash premium and Selio's 0.2% fee on the sale), and returns unsold collateral and surplus to the borrower, all in one transaction.",
  ];
  let simulation: "passed" | "pending-approval";
  if (approval.transactions.length === 0) {
    const outcome = await h.reads.call({ from, to: tx.to, data: tx.data, value: tx.value });
    if (!outcome.ok) {
      const decoded = decodeRevert(outcome.revertData);
      throw new ToolError(
        `Simulation of the fallback route failed (${decoded ? decoded.signature : outcome.message}); do not send it.`,
      );
    }
    simulation = "passed";
  } else {
    simulation = "pending-approval";
    notes.push(
      "The route transaction could not be simulated yet because it needs the approval first. After the approval confirms, run simulate_transaction on the route transaction and send it only if the simulation succeeds.",
    );
  }
  return buildResult(h, args.network, [...approval.transactions, tx], notes, {
    collateralOffered: amountView(collateral, receipt),
    collateralSoldPlan: amountView(plan.filledAssets, receipt),
    repay: amountView(repay, pay.token),
    plannedProceeds: amountView(proceeds, pay.token),
    fee: amountView(fee, pay.token),
    minProceeds: amountView(minProceeds, pay.token),
    averageDiscount: bpsView(plan.averageDiscountBps),
    simulation,
  });
}

