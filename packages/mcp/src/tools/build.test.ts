import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  maxUint256,
  erc20Abi as viemErc20Abi,
  zeroAddress,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  kuruSellRouterAbi,
  morphoMarketId,
  selioVaultAbi,
  type BidView,
  type Deployment,
  type MorphoMarketParams,
  type SellPlan,
} from "@selio/sdk";
import {
  AAVE_DEPLOYMENT,
  ADDR,
  KURU_AAVE_DEPLOYMENT,
  KURU_MARKET,
  MORPHO_DEPLOYMENT,
  ROUTED_SALE,
  SELIO_LEG,
  fakeChain,
  fakeNetwork,
  session,
} from "../testing/fakes.js";
import {
  VAULT_DEPOSIT_SLIPPAGE_BPS,
  buildBuyAndRepay,
  buildBuyAndRepayShape,
  buildBuyWithCollateral,
  buildCancelBid,
  buildOpenSession,
  buildOpenSessionShape,
  buildPlaceBid,
  buildRouteRepayWithFrozenCollateral,
  buildSellNow,
  buildVaultDeposit,
  buildVaultRedeem,
  buildWithdrawUnsold,
  isLiquidityMarket,
} from "./build.js";
import type { BuildResult, TxView } from "./common.js";

const MARKET_PARAMS = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;
const AUTH = {
  type: "tuple",
  components: [
    { name: "authorizer", type: "address" },
    { name: "authorized", type: "address" },
    { name: "isAuthorized", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const SIG = {
  type: "tuple",
  components: [
    { name: "v", type: "uint8" },
    { name: "r", type: "bytes32" },
    { name: "s", type: "bytes32" },
  ],
} as const;

const WETH_MARKET: MorphoMarketParams = {
  loanToken: ADDR.morphoUSDC,
  collateralToken: ADDR.morphoWETH,
  oracle: ADDR.oracle,
  irm: ADDR.irm,
  lltv: 860_000_000_000_000_000n,
};

const now = () => 1_700_000_100n;
const market = (tx: TxView | undefined) => decodeFunctionData({ abi: aaveExitMarketAbi, data: tx!.data });
const approval = (tx: TxView | undefined) => decodeFunctionData({ abi: viemErc20Abi, data: tx!.data });
const vault = (tx: TxView | undefined) => decodeFunctionData({ abi: selioVaultAbi, data: tx!.data });

/** Every transaction is a plain unsigned call with no native value. */
function expectUnsigned(res: BuildResult) {
  for (const tx of res.transactions) {
    expect(Object.keys(tx).sort()).toEqual(["data", "description", "to", "value"]);
    expect(tx.value).toBe("0");
  }
}

function onAave(deployment: Deployment = AAVE_DEPLOYMENT) {
  const net = fakeNetwork(deployment);
  return { net, ctx: { chain: fakeChain({ "usdt0-replay": net.handle }), nowSeconds: now } };
}

function onMorpho() {
  const net = fakeNetwork(MORPHO_DEPLOYMENT);
  return { net, ctx: { chain: fakeChain({ "vault-freeze": net.handle }), nowSeconds: now } };
}

function aaveBuyer(deployment?: Deployment) {
  const env = onAave(deployment);
  vi.spyOn(env.net.sdk, "session").mockResolvedValue(session());
  vi.spyOn(env.net.sdk, "position").mockResolvedValue({ debt: 5_000_000n, health: 2n * 10n ** 18n });
  vi.spyOn(env.net.sdk, "quote").mockResolvedValue(4_900_000_000n);
  return env;
}

function morphoBuyer(collateralToken: `0x${string}` = ADDR.morphoWETH) {
  const env = onMorpho();
  const params = { ...WETH_MARKET, collateralToken };
  vi.spyOn(env.net.sdk, "session").mockResolvedValue(
    session({
      remainingAssets: 10_000_000_000n,
      units: 10n ** 22n,
      payMask: 0b11,
      acceptedPayTokens: [ADDR.morphoUSDC, ADDR.morphoWETH],
    }),
  );
  vi.spyOn(env.net.sdk, "position").mockResolvedValue({
    debt: 5_000_000_000n,
    health: 1_500_000_000_000_000_000n,
    market: params,
    marketId: morphoMarketId(params),
    collateral: 10n ** 22n,
  });
  vi.spyOn(env.net.sdk, "quote").mockResolvedValue(980n * 10n ** 18n);
  env.net.reads.morphoNonce.mockResolvedValue(7n);
  return env;
}

const AAVE_BUY = { network: "usdt0-replay", sessionId: 1, assets: "2.5", payToken: "USDC", from: ADDR.user } as const;
const MORPHO_BUY = { network: "vault-freeze", sessionId: 1, assets: "1000", payToken: "WETH", from: ADDR.user } as const;

describe("build_buy_and_repay", () => {
  it("approves the quote plus the oracle buffer and buys with the fee on the seller's side", async () => {
    const { ctx } = aaveBuyer();
    const res = await buildBuyAndRepay(ctx, AAVE_BUY);
    expectUnsigned(res);
    expect(res.chainId).toBe(143);
    expect(res.transactions).toHaveLength(2);
    const [approve, buy] = res.transactions;
    expect(approve?.to).toBe(ADDR.USDC);
    expect(approval(approve).args).toEqual([ADDR.market, 4_924_500_000n]);
    expect(approve?.description).toBe(`Approve the Selio market (${ADDR.market}) to spend 4924.5 USDC`);
    expect(buy?.to).toBe(ADDR.market);
    expect(market(buy)).toMatchObject({ functionName: "buyAndRepay", args: [1n, 2_500_000n, 1, 4_924_500_000n, "0x"] });
    expect(res.details?.maxPay).toEqual({ raw: "4924500000", human: "4924.5", symbol: "USDC" });
    expect(res.details?.fee).toEqual({ raw: "9800000", human: "9.8", symbol: "USDC" });
    expect(res.details?.sellerNet).toEqual({ raw: "4890200000", human: "4890.2", symbol: "USDC" });
    expect(res.notes.join(" ")).toMatch(/0\.5% buffer/);
    expect(res.notes.at(-1)).toMatch(/^These transactions are unsigned/);
  });

  it("skips the approval when the allowance covers an explicit maxPay", async () => {
    const { net, ctx } = aaveBuyer();
    vi.spyOn(net.sdk, "allowance").mockResolvedValue(maxUint256);
    const res = await buildBuyAndRepay(ctx, { ...AAVE_BUY, payToken: "USDT0", maxPay: "5000" });
    expect(res.transactions).toHaveLength(1);
    expect(market(res.transactions[0]).args?.[3]).toBe(5_000_000_000n);
    expect(res.notes.join(" ")).not.toMatch(/buffer/);
  });

  it("requires same-asset debt of at least the face value", async () => {
    const { ctx } = aaveBuyer();
    await expect(buildBuyAndRepay(ctx, { ...AAVE_BUY, assets: "6" })).rejects.toThrow(/owes 5 USDT0/);
  });

  it("checks an explicit maxPay against the price and the token's decimals", async () => {
    const { ctx } = aaveBuyer();
    await expect(buildBuyAndRepay(ctx, { ...AAVE_BUY, maxPay: "100" })).rejects.toThrow(/below the current price/);
    await expect(buildBuyAndRepay(ctx, { ...AAVE_BUY, maxPay: "5000.0000001" })).rejects.toThrow(/only has 6/);
  });

  it("requires from in its schema", () => {
    const schema = z.object(buildBuyAndRepayShape);
    expect(schema.safeParse(AAVE_BUY).success).toBe(true);
    const { from: _from, ...withoutFrom } = AAVE_BUY;
    expect(schema.safeParse(withoutFrom).success).toBe(false);
  });

  it("asks for forced deallocation when the buyer's market is not the Earn vault's liquidity market", async () => {
    const { net, ctx } = morphoBuyer();
    vi.spyOn(net.sdk, "quote").mockResolvedValue(1_000_000_000n);
    const args = { ...MORPHO_BUY, payToken: "USDC" };
    const forceOf = (res: BuildResult) => {
      const venueData = market(res.transactions.at(-1)).args?.[4] as Hex;
      return decodeAbiParameters([MARKET_PARAMS, { type: "bool" }, { type: "bytes" }], venueData)[1];
    };
    // vault-freeze: no liquidity adapter, so every purchase force-deallocates.
    expect(forceOf(await buildBuyAndRepay(ctx, args))).toBe(true);
    net.reads.morphoLiquidity.mockResolvedValue({
      adapter: ADDR.adapter,
      data: encodeAbiParameters([MARKET_PARAMS], [WETH_MARKET]),
    });
    expect(forceOf(await buildBuyAndRepay(ctx, args))).toBe(false);
    net.reads.morphoLiquidity.mockResolvedValue({
      adapter: ADDR.adapter,
      data: encodeAbiParameters([MARKET_PARAMS], [{ ...WETH_MARKET, lltv: 915_000_000_000_000_000n }]),
    });
    expect(forceOf(await buildBuyAndRepay(ctx, args))).toBe(true);
  });
});

describe("isLiquidityMarket", () => {
  it("matches only the market the liquidity adapter and data point at", () => {
    const data = encodeAbiParameters([MARKET_PARAMS], [WETH_MARKET]);
    expect(isLiquidityMarket(ADDR.adapter, data, ADDR.adapter, WETH_MARKET)).toBe(true);
    expect(isLiquidityMarket(ADDR.adapter.toLowerCase() as Hex, data, ADDR.adapter, WETH_MARKET)).toBe(true);
    expect(isLiquidityMarket(ADDR.morpho, data, ADDR.adapter, WETH_MARKET)).toBe(false);
    expect(isLiquidityMarket(zeroAddress, "0x", ADDR.adapter, WETH_MARKET)).toBe(false);
    expect(isLiquidityMarket(ADDR.adapter, "0x1234", ADDR.adapter, WETH_MARKET)).toBe(false);
    expect(isLiquidityMarket(ADDR.adapter, data, ADDR.adapter, { ...WETH_MARKET, lltv: 1n })).toBe(false);
  });
});

describe("build_buy_with_collateral", () => {
  it("Aave: approves the pay token's aToken with the pull margin and buys with empty venue data", async () => {
    const { net, ctx } = aaveBuyer();
    vi.spyOn(net.sdk, "quote").mockResolvedValue(1_000_000_000n);
    vi.spyOn(net.sdk, "collateralPullMargin").mockResolvedValue(3n);
    const res = await buildBuyWithCollateral(ctx, { ...AAVE_BUY, assets: "1", maxPay: "1000" });
    const [approve, buy] = res.transactions;
    expect(approve?.to).toBe(ADDR.aMonUSDC);
    expect(approval(approve).args).toEqual([ADDR.market, 1_000_000_003n]);
    expect(market(buy)).toMatchObject({
      functionName: "buyAndRepayWithCollateral",
      args: [1n, 1_000_000n, 1, 1_000_000_000n, "0x"],
    });
    expect(res.details).toMatchObject({ collateralAToken: { symbol: "aMonUSDC", address: ADDR.aMonUSDC } });
  });

  it("refuses the underlying as the pay token", async () => {
    const { ctx } = aaveBuyer();
    await expect(buildBuyWithCollateral(ctx, { ...AAVE_BUY, payToken: "USDT0" })).rejects.toThrow(/cannot be the underlying/);
  });

  it("Aave: refuses a pay token without a collateral aToken", async () => {
    const { ctx } = aaveBuyer({
      ...AAVE_DEPLOYMENT,
      payATokens: [zeroAddress, ADDR.aMonUSDC, zeroAddress, ADDR.aMonWETH],
    });
    await expect(buildBuyWithCollateral(ctx, { ...AAVE_BUY, payToken: "AUSD" })).rejects.toThrow(/no Aave collateral aToken/);
  });

  it("Morpho step one: returns grant and revoke typed data and no transaction", async () => {
    const { ctx } = morphoBuyer();
    const res = await buildBuyWithCollateral(ctx, MORPHO_BUY);
    expect(res.transactions).toEqual([]);
    if (!("signatureRequests" in res)) throw new Error("expected signature requests");
    expect(res.signatureRequests.map((r) => r.name)).toEqual(["grant", "revoke"]);
    const [grant, revoke] = res.signatureRequests;
    expect(grant?.typedData.domain).toEqual({ chainId: 143, verifyingContract: ADDR.morpho });
    expect(grant?.typedData.message).toMatchObject({
      authorizer: ADDR.user,
      authorized: ADDR.morphoMarket,
      isAuthorized: true,
      nonce: "7",
      deadline: "1700003700",
    });
    expect(revoke?.typedData.message).toMatchObject({ isAuthorized: false, nonce: "8", deadline: "1700003700" });
    expect(res.notes.join(" ")).toMatch(/two EIP-712 signatures/);
    expect(res.notes.join(" ")).not.toMatch(/These transactions are unsigned/);
  });

  it("Morpho step two: carries both signatures in the venue data of one purchase", async () => {
    const { ctx } = morphoBuyer();
    const first = await buildBuyWithCollateral(ctx, MORPHO_BUY);
    if (!("signatureRequests" in first)) throw new Error("expected signature requests");
    // The test plays the buyer's wallet; the MCP server itself never signs.
    const wallet = privateKeyToAccount(generatePrivateKey());
    const [grantSignature, revokeSignature] = await Promise.all(
      first.signatureRequests.map(({ typedData }) =>
        wallet.signTypedData({
          domain: typedData.domain,
          types: { Authorization: typedData.types.Authorization },
          primaryType: "Authorization",
          message: {
            ...typedData.message,
            nonce: BigInt(typedData.message.nonce),
            deadline: BigInt(typedData.message.deadline),
          },
        }),
      ),
    );
    const res = await buildBuyWithCollateral(ctx, {
      ...MORPHO_BUY,
      authorization: { nonce: "7", deadline: "1700003700", grantSignature: grantSignature!, revokeSignature: revokeSignature! },
    });
    expect(res.transactions).toHaveLength(1);
    const call = market(res.transactions[0]);
    expect(call.functionName).toBe("buyAndRepayWithCollateral");
    expect(call.args?.[1]).toBe(1_000_000_000n);
    expect(call.args?.[2]).toBe(1);
    const [params, force, auth] = decodeAbiParameters(
      [MARKET_PARAMS, { type: "bool" }, { type: "bytes" }],
      call.args?.[4] as Hex,
    );
    expect(params.collateralToken).toBe(ADDR.morphoWETH);
    expect(force).toBe(true);
    const [grant, grantSig, revoke] = decodeAbiParameters([AUTH, SIG, AUTH, SIG], auth);
    expect(grant).toMatchObject({ authorizer: ADDR.user, isAuthorized: true, nonce: 7n, deadline: 1_700_003_700n });
    expect(revoke).toMatchObject({ isAuthorized: false, nonce: 8n });
    expect(grantSig.r).toBe(grantSignature!.slice(0, 66));
    expect(res.notes.join(" ")).toMatch(/no permission survives it/);
  });

  it("Morpho step two: refuses signatures made for an older nonce", async () => {
    const { net, ctx } = morphoBuyer();
    net.reads.morphoNonce.mockResolvedValue(9n);
    const sig = `0x${"11".repeat(64)}1b` as Hex;
    await expect(
      buildBuyWithCollateral(ctx, {
        ...MORPHO_BUY,
        authorization: { nonce: "7", deadline: "1700003700", grantSignature: sig, revokeSignature: sig },
      }),
    ).rejects.toThrow(/nonce 7.*now 9/);
  });

  it("Morpho: requires the buyer's own collateral as the pay token", async () => {
    const { ctx } = morphoBuyer(ADDR.AUSD);
    await expect(buildBuyWithCollateral(ctx, MORPHO_BUY)).rejects.toThrow(/collateral is AUSD/);
  });
});

describe("build_open_session", () => {
  it("escrows the receipt amount and reports what the seller receives at the start and at the cap", async () => {
    const { net, ctx } = onMorpho();
    const receiptAmountFor = vi.spyOn(net.sdk, "receiptAmountFor").mockResolvedValue(999n * 10n ** 18n);
    vi.spyOn(net.sdk, "quote").mockImplementation(async (_assets, discountBps) =>
      discountBps === 100 ? 990_000_000n : 900_000_000n,
    );
    const res = await buildOpenSession(ctx, {
      network: "vault-freeze",
      assets: "1000",
      payTokens: ["WETH"],
      startBps: 100,
      stepBps: 50,
      stepIntervalSeconds: 600,
      capBps: 1_000,
      durationSeconds: 86_400,
    });
    expect(receiptAmountFor).toHaveBeenCalledWith(1_000_000_000n);
    const [approve, open] = res.transactions;
    expect(approve?.to).toBe(ADDR.hyperUSDCa);
    expect(approval(approve).args).toEqual([ADDR.morphoMarket, 999n * 10n ** 18n]);
    expect(market(open).args).toEqual([
      999n * 10n ** 18n,
      { startBps: 100, stepBps: 50, stepInterval: 600, capBps: 1_000, duration: 86_400, payMask: 0b10 },
    ]);
    expect(res.notes.join(" ")).toMatch(/no "from" address/);
    expect(res.notes.join(" ")).toMatch(/Morpho receipts are vault shares/);
    expect(res.details).toMatchObject({
      feeRate: { percent: "0.20%" },
      atStart: { payment: { human: "990" }, fee: { human: "1.98" }, sellerNet: { human: "988.02" } },
      atCap: { payment: { human: "900" }, fee: { human: "1.8" }, sellerNet: { human: "898.2" } },
      acceptedPayTokens: ["WETH"],
    });
  });

  it("validates the schedule", async () => {
    const { ctx } = onMorpho();
    const args = {
      network: "vault-freeze",
      assets: "1",
      startBps: 2_000,
      stepBps: 50,
      stepIntervalSeconds: 600,
      capBps: 1_000,
      durationSeconds: 86_400,
    } as const;
    await expect(buildOpenSession(ctx, args)).rejects.toThrow(/startBps/);
    const schema = z.object(buildOpenSessionShape);
    expect(schema.safeParse({ ...args, startBps: 100 }).success).toBe(true);
    expect(schema.safeParse({ ...args, capBps: 6_000 }).success).toBe(false);
    expect(schema.safeParse({ ...args, durationSeconds: 31 * 24 * 3600 }).success).toBe(false);
  });
});

describe("build_withdraw_unsold and build_cancel_bid", () => {
  it("withdraws every unsold unit for the seller only", async () => {
    const { net, ctx } = onAave();
    vi.spyOn(net.sdk, "session").mockResolvedValue(session());
    const res = await buildWithdrawUnsold(ctx, { network: "usdt0-replay", sessionId: 1, from: ADDR.seller });
    expect(market(res.transactions[0])).toMatchObject({ functionName: "withdrawUnsold", args: [1n, maxUint256] });
    expect(res.details).toMatchObject({ sessionId: "1", unsold: { human: "10", symbol: "USDT0" } });
    await expect(
      buildWithdrawUnsold(ctx, { network: "usdt0-replay", sessionId: 1, from: ADDR.user }),
    ).rejects.toThrow(/Only the seller/);
  });

  it("cancels an active bid and reports the refund", async () => {
    const { net, ctx } = onAave();
    const bid: BidView = {
      id: 4n,
      bidder: ADDR.bidder,
      minDiscountBps: 300,
      payIdx: 1,
      payToken: ADDR.USDC,
      maxAssets: 5_000_000n,
      escrow: 2_000_000_000n,
      capacityAssets: 500_000n,
    };
    vi.spyOn(net.sdk, "bids").mockResolvedValue([bid]);
    const res = await buildCancelBid(ctx, { network: "usdt0-replay", bidId: "4", from: ADDR.bidder });
    expect(market(res.transactions[0])).toMatchObject({ functionName: "cancelBid", args: [4n] });
    expect(res.details?.refund).toEqual({ raw: "2000000000", human: "2000", symbol: "USDC" });
    await expect(buildCancelBid(ctx, { network: "usdt0-replay", bidId: 5 })).rejects.toThrow(/not active/);
  });
});

describe("build_place_bid", () => {
  it("escrows the pay token and notes a partial escrow", async () => {
    const { net, ctx } = onAave();
    vi.spyOn(net.sdk, "quote").mockResolvedValue(9_500_000_000n);
    const res = await buildPlaceBid(ctx, {
      network: "usdt0-replay",
      minDiscountBps: 300,
      payToken: "AUSD",
      maxAssets: "5",
      escrow: "9000",
    });
    const [approve, place] = res.transactions;
    expect(approve?.to).toBe(ADDR.AUSD);
    expect(approval(approve).args).toEqual([ADDR.market, 9_000_000_000n]);
    expect(market(place)).toMatchObject({ functionName: "placeBid", args: [300, 0, 5_000_000n, 9_000_000_000n] });
    expect(res.notes.join(" ")).toMatch(/covers only part/);
    expect(res.details?.escrowForFullFill).toEqual({ raw: "9500000000", human: "9500", symbol: "AUSD" });
  });
});

describe("build_sell_now", () => {
  const plan: SellPlan = {
    bidIds: [3n, 4n],
    fills: [3n, 4n].map((bidId) => ({
      bidId,
      assets: 1_000_000n,
      pay: 950_000_000n,
      fee: 1_900_000n,
      sellerNet: 948_100_000n,
      payToken: ADDR.USDC,
      discountBps: 500,
    })),
    filledAssets: 2_000_000n,
    proceeds: { [ADDR.USDC]: 1_900_000_000n },
    fees: { [ADDR.USDC]: 3_800_000n },
    sellerNet: { [ADDR.USDC]: 1_896_200_000n },
    averageDiscountBps: 500,
  };

  it("sells what the bids absorb, with the fee and the seller's net per token", async () => {
    const { net, ctx } = onAave();
    vi.spyOn(net.sdk, "planSellNow").mockResolvedValue(plan);
    const res = await buildSellNow(ctx, { network: "usdt0-replay", assets: "3", maxDiscountBps: 500 });
    const [approve, sell] = res.transactions;
    expect(approve?.to).toBe(ADDR.aMonUSDT0);
    expect(approval(approve).args).toEqual([ADDR.market, 2_000_000n]);
    expect(market(sell)).toMatchObject({ functionName: "sellNow", args: [2_000_000n, [3n, 4n], 500, 0b1111, 2_000_000n] });
    expect(res.details).toMatchObject({
      bidIds: ["3", "4"],
      proceeds: [{ raw: "1900000000", human: "1900", symbol: "USDC" }],
      fees: [{ raw: "3800000", human: "3.8", symbol: "USDC" }],
      sellerNet: [{ raw: "1896200000", human: "1896.2", symbol: "USDC" }],
    });
    expect(res.notes.join(" ")).toMatch(/Only 2 of 3 USDT0/);
  });

  it("fails when no bid qualifies", async () => {
    const { net, ctx } = onAave();
    vi.spyOn(net.sdk, "planSellNow").mockResolvedValue({
      ...plan,
      bidIds: [],
      fills: [],
      filledAssets: 0n,
      proceeds: {},
      fees: {},
      sellerNet: {},
      averageDiscountBps: 0,
    });
    await expect(buildSellNow(ctx, { network: "usdt0-replay", assets: "3", maxDiscountBps: 500 })).rejects.toThrow(
      /No escrowed bid/,
    );
  });
});

describe("build_sell_now with Kuru", () => {
  function onKuru() {
    const env = onAave(KURU_AAVE_DEPLOYMENT);
    vi.spyOn(env.net.sdk, "kuruMarket").mockResolvedValue(KURU_MARKET);
    return env;
  }

  it("builds the routed sale through KuruSellRouter and the receipt approval to the router", async () => {
    const { net, ctx } = onKuru();
    const routed = vi.spyOn(net.sdk, "planRoutedSell").mockResolvedValue(ROUTED_SALE);
    const res = await buildSellNow(ctx, {
      network: "usdt0-replay",
      from: ADDR.seller,
      assets: "120",
      maxDiscountBps: 5_000,
      payTokens: ["USDT0"],
    });
    expect(routed).toHaveBeenCalledWith(120_000_000n, 5_000, 0b0100);
    expectUnsigned(res);
    const [approve, sell] = res.transactions;
    expect(approve?.to).toBe(ADDR.aMonUSDT0);
    // Aave receipts: both legs plus 10 wei for each transfer (one Selio fill, the pull and the wrap).
    expect(approval(approve).args).toEqual([ADDR.kuruSellRouter, 69_891_800n + 50_108_201n + 30n]);
    expect(sell?.to).toBe(ADDR.kuruSellRouter);
    expect(sell?.description).toBe("Sell receipts now: Selio bids and the Kuru order book, best price per unit");
    expect(decodeFunctionData({ abi: kuruSellRouterAbi, data: sell!.data })).toEqual({
      functionName: "sell",
      args: [
        {
          selioAssets: 69_891_800n,
          bidIds: [1n],
          maxDiscountBps: 5_000,
          payMask: 0b0100,
          selioMinFilled: 69_891_800n,
          kuruAssets: 50_108_201n,
          kuruMinOut: 48_755_000n,
          to: ADDR.seller,
        },
      ],
    });
    expect(res.details).toMatchObject({
      route: "selio+kuru",
      filled: { raw: "120000000" },
      bidIds: ["1"],
      sellerNet: [{ raw: "67659456", symbol: "USDT0" }],
      kuru: { expectedOut: { raw: "49000000" }, minOut: { raw: "48755000" }, takerFeeBps: 0 },
      router: ADDR.kuruSellRouter,
    });
    expect(res.notes.join(" ")).toMatch(/the Kuru part pay at least 48\.755 USDT0/);
  });

  it("skips the approval when the router allowance already covers it, and checks minFilled", async () => {
    const { net, ctx } = onKuru();
    vi.spyOn(net.sdk, "planRoutedSell").mockResolvedValue(ROUTED_SALE);
    vi.spyOn(net.sdk, "allowance").mockResolvedValue(maxUint256);
    const res = await buildSellNow(ctx, { network: "usdt0-replay", from: ADDR.seller, assets: "120", maxDiscountBps: 5_000 });
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0]?.to).toBe(ADDR.kuruSellRouter);
    await expect(
      buildSellNow(ctx, { network: "usdt0-replay", assets: "120", maxDiscountBps: 5_000, minFilled: "121" }),
    ).rejects.toThrow(/Kuru book can only absorb 120 USDT0, below minFilled/);
  });

  it("sends the plain sellNow when the routed plan keeps to Selio's bids, or with useKuru false", async () => {
    const { net, ctx } = onKuru();
    vi.spyOn(net.sdk, "planRoutedSell").mockResolvedValue({ ...ROUTED_SALE, kuru: null, route: "selio" });
    const selioOnly = vi.spyOn(net.sdk, "planSellNow").mockResolvedValue(SELIO_LEG);
    const res = await buildSellNow(ctx, { network: "usdt0-replay", assets: "120", maxDiscountBps: 5_000 });
    expect(selioOnly).not.toHaveBeenCalled();
    const [approve, sell] = res.transactions;
    expect(approval(approve).args).toEqual([ADDR.market, 69_891_800n]);
    expect(market(sell)).toMatchObject({ functionName: "sellNow", args: [69_891_800n, [1n], 5_000, 0b1111, 69_891_800n] });
    expect(res.details).toMatchObject({ route: "selio" });
    const off = await buildSellNow(ctx, { network: "usdt0-replay", assets: "120", maxDiscountBps: 5_000, useKuru: false });
    expect(selioOnly).toHaveBeenCalledTimes(1);
    expect(market(off.transactions[1]).functionName).toBe("sellNow");
    expect(off.details).not.toHaveProperty("route");
  });
});

describe("build_vault_deposit and build_vault_redeem", () => {
  it("deposits with a minimum of shares below the current preview", async () => {
    const { net, ctx } = onAave();
    vi.spyOn(net.sdk, "vaultPreviewDeposit").mockResolvedValue(1_250_000_000n);
    const res = await buildVaultDeposit(ctx, { network: "usdt0-replay", assets: "1.25", from: ADDR.user, slippageBps: 100 });
    const [approve, deposit] = res.transactions;
    expect(approve?.to).toBe(ADDR.USDT0);
    expect(approval(approve).args).toEqual([ADDR.aaveVault, 1_250_000n]);
    expect(deposit?.to).toBe(ADDR.aaveVault);
    expect(vault(deposit)).toMatchObject({ functionName: "deposit", args: [1_250_000n, ADDR.user, 1_237_500_000n] });
    expect(res.details).toMatchObject({
      receiver: ADDR.user,
      expectedShares: { raw: "1250000000", symbol: "slUSDT0" },
      minShares: { raw: "1237500000" },
      baseYield: null,
    });
    const byDefault = await buildVaultDeposit(ctx, { network: "usdt0-replay", assets: "1.25", from: ADDR.user });
    const minShares = (1_250_000_000n * BigInt(10_000 - VAULT_DEPOSIT_SLIPPAGE_BPS)) / 10_000n;
    expect(vault(byDefault.transactions[1]).args?.[2]).toBe(minShares);
    await expect(buildVaultDeposit(ctx, { network: "usdt0-replay", assets: "1" })).rejects.toThrow(/receiver/);
  });

  it("redeems all shares with the preview and an optional skip list", async () => {
    const { net, ctx } = onAave();
    vi.spyOn(net.sdk, "balanceOf").mockResolvedValue(5_000_000_000n);
    net.reads.vaultPreviewRedeem.mockResolvedValue({ assets: 3_000_000n, receipts: [2_000_000n], sourceSharesInKind: 0n });
    const res = await buildVaultRedeem(ctx, { network: "usdt0-replay", from: ADDR.user });
    expect(vault(res.transactions[0])).toMatchObject({
      functionName: "redeem",
      args: [5_000_000_000n, ADDR.user, ADDR.user, []],
    });
    expect(res.details).toMatchObject({
      receiveNow: { raw: "3000000", human: "3", symbol: "USDT0" },
      receiveInKind: { raw: "2000000", human: "2", symbol: "aMonUSDT0" },
      baseYield: null,
    });
    expect(res.details).not.toHaveProperty("skipped");
    const skipping = await buildVaultRedeem(ctx, { network: "usdt0-replay", from: ADDR.user, skip: [ADDR.aMonUSDT0] });
    expect(vault(skipping.transactions[0]).args?.[3]).toEqual([0n]);
    expect(skipping.details?.skipped).toEqual([ADDR.aMonUSDT0]);
    expect(skipping.notes.join(" ")).toMatch(/stay in the vault/);
    await expect(
      buildVaultRedeem(ctx, { network: "usdt0-replay", from: ADDR.user, skip: [ADDR.USDC] }),
    ).rejects.toThrow(/not a receipt the Selio Vault holds/);
  });

  it("reports the vault's base yield on a deposit", async () => {
    const { net, ctx } = onMorpho();
    vi.spyOn(net.sdk, "vaultPreviewDeposit").mockResolvedValue(10n ** 12n);
    net.reads.vaultBaseYield.mockResolvedValue({
      source: ADDR.waMonUSDC,
      sourceShares: 790_000_000n,
      sourceAssets: 800_000_000n,
      sourceUtilizationBps: 4_200,
    });
    const res = await buildVaultDeposit(ctx, { network: "vault-freeze", assets: "1000", from: ADDR.user });
    expect(res.details?.baseYield).toEqual({
      source: ADDR.waMonUSDC,
      symbol: "waMonUSDC",
      sourceAssets: { raw: "800000000", human: "800", symbol: "USDC" },
      sourceShares: { raw: "790000000", human: "790", symbol: "waMonUSDC" },
      sourceUtilization: { bps: 4_200, percent: "42.00%" },
    });
  });

  it("reports the source shares a redemption pays in kind when the source cannot pay", async () => {
    const { net, ctx } = onMorpho();
    net.reads.vaultBaseYield.mockResolvedValue({
      source: ADDR.waMonUSDC,
      sourceShares: 790_000_000n,
      sourceAssets: 800_000_000n,
      sourceUtilizationBps: 10_000,
    });
    net.reads.vaultPreviewRedeem.mockResolvedValue({
      assets: 2_000_000n,
      receipts: [0n],
      sourceSharesInKind: 1_500_000n,
    });
    const res = await buildVaultRedeem(ctx, { network: "vault-freeze", from: ADDR.user, shares: "1" });
    expect(vault(res.transactions[0]).args?.[0]).toBe(1_000_000_000n);
    expect(res.details?.baseYield).toMatchObject({
      sourceUtilization: { percent: "100.00%" },
      sourceSharesInKind: { raw: "1500000", human: "1.5", symbol: "waMonUSDC" },
    });
    expect(res.notes.join(" ")).toMatch(/1\.5 waMonUSDC \(the source's own shares\) come back in kind/);
  });
});

describe("build_route_repay_with_frozen_collateral", () => {
  const plan: SellPlan = {
    bidIds: [4n],
    fills: [
      {
        bidId: 4n,
        assets: 2_000_000n,
        pay: 3_800_000_000n,
        fee: 7_600_000n,
        sellerNet: 3_792_400_000n,
        payToken: ADDR.USDC,
        discountBps: 500,
      },
    ],
    filledAssets: 2_000_000n,
    proceeds: { [ADDR.USDC]: 3_800_000_000n },
    fees: { [ADDR.USDC]: 7_600_000n },
    sellerNet: { [ADDR.USDC]: 3_792_400_000n },
    averageDiscountBps: 500,
  };
  const args = {
    network: "usdt0-replay",
    from: ADDR.user,
    collateralAmount: "2",
    repayToken: "USDC",
    repayAmount: "3000",
    maxDiscountBps: 500,
  } as const;

  function frozenPool(withdrawable = 0n) {
    const env = onAave();
    vi.spyOn(env.net.sdk, "capacity").mockResolvedValue({
      withdrawable,
      supplied: 10n ** 12n,
      utilizationBps: 10_000,
      debtorCapacity: 0n,
      sessionAssets: 0n,
    });
    vi.spyOn(env.net.sdk, "planSellNow").mockResolvedValue(plan);
    return env;
  }

  it("only runs on Aave, and only for collateral that cannot be withdrawn", async () => {
    const { ctx } = onMorpho();
    await expect(
      buildRouteRepayWithFrozenCollateral(ctx, { ...args, network: "vault-freeze" }),
    ).rejects.toThrow(/only available on Aave/);
    const liquid = frozenPool(5_000_000n);
    await expect(buildRouteRepayWithFrozenCollateral(liquid.ctx, args)).rejects.toThrow(/withdrawn directly/);
  });

  it("simulates the route and compares the proceeds net of the fee", async () => {
    const { net, ctx } = frozenPool();
    vi.spyOn(net.sdk, "allowance").mockResolvedValue(maxUint256);
    const res = await buildRouteRepayWithFrozenCollateral(ctx, args);
    expect(res.transactions).toHaveLength(1);
    const tx = res.transactions[0]!;
    expect(tx.to).toBe(ADDR.route);
    expect(decodeFunctionData({ abi: aaveCollateralRouteAbi, data: tx.data })).toMatchObject({
      functionName: "repayWithFrozenCollateral",
      args: [ADDR.market, 2_000_000n, [4n], 500, 1, 3_000_000_000n, 3_000_000_000n],
    });
    expect(res.details).toMatchObject({
      simulation: "passed",
      plannedProceeds: { raw: "3792400000" },
      fee: { raw: "7600000" },
      minProceeds: { raw: "3000000000" },
    });
    expect(net.reads.call).toHaveBeenCalledWith(expect.objectContaining({ from: ADDR.user, to: ADDR.route }));
    await expect(buildRouteRepayWithFrozenCollateral(ctx, { ...args, minProceeds: "3900" })).rejects.toThrow(
      /less than minProceeds/,
    );
    // The gross 3,800 USDC would cover it; the net 3,792.4 does not.
    await expect(buildRouteRepayWithFrozenCollateral(ctx, { ...args, minProceeds: "3795" })).rejects.toThrow(
      /less than minProceeds/,
    );
    await expect(buildRouteRepayWithFrozenCollateral(ctx, { ...args, repayAmount: "5000" })).rejects.toThrow(
      /less than repayAmount/,
    );
  });

  it("refuses a route whose simulation reverts", async () => {
    const { net, ctx } = frozenPool();
    vi.spyOn(net.sdk, "allowance").mockResolvedValue(maxUint256);
    net.reads.call.mockResolvedValue({
      ok: false,
      revertData: encodeErrorResult({ abi: aaveCollateralRouteAbi, errorName: "ProceedsTooLow", args: [1n, 2n] }),
      message: "execution reverted",
    });
    await expect(buildRouteRepayWithFrozenCollateral(ctx, args)).rejects.toThrow(
      /ProceedsTooLow\(uint256 proceeds, uint256 needed\).*do not send/,
    );
  });

  it("returns the approval first and leaves the simulation for later", async () => {
    const { net, ctx } = frozenPool();
    const res = await buildRouteRepayWithFrozenCollateral(ctx, args);
    expect(res.transactions.map((t) => t.to)).toEqual([ADDR.aMonUSDT0, ADDR.route]);
    expect(approval(res.transactions[0]).args).toEqual([ADDR.route, 2_000_000n]);
    expect(res.details?.simulation).toBe("pending-approval");
    expect(net.reads.call).not.toHaveBeenCalled();
  });
});
