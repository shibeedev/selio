import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BidView, KuruLevel, SellPlan } from "@selio/sdk";
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
  CAPACITY_DISCOUNT_LEVELS,
  LIST_BIDS_MAX_LIMIT,
  getBorrowerPosition,
  getExitCapacity,
  listBids,
  listBidsShape,
  listNetworks,
  planSellNow,
  planSellNowShape,
  quotePurchase,
  quotePurchaseShape,
} from "./read.js";

function aave() {
  const net = fakeNetwork(AAVE_DEPLOYMENT);
  return { net, ctx: { chain: fakeChain({ "usdt0-replay": net.handle }) } };
}

function bid(overrides: Partial<BidView>): BidView {
  return {
    id: 1n,
    bidder: ADDR.bidder,
    minDiscountBps: 300,
    payIdx: 1,
    payToken: ADDR.USDC,
    maxAssets: 5_000_000n,
    escrow: 2_000_000_000n,
    capacityAssets: 500_000n,
    ...overrides,
  };
}

describe("list_networks", () => {
  it("lists every network with its deployment state", async () => {
    const { ctx } = aave();
    const { networks } = await listNetworks(ctx);
    expect(networks.map((n) => n.network)).toEqual(["monad-testnet", "usdt0-replay", "vault-freeze"]);
    const replay = networks.find((n) => n.network === "usdt0-replay");
    expect(replay).toMatchObject({ deployed: true, chainId: 143, venue: "aave", isFork: true });
    expect(replay?.contracts?.market).toBe(ADDR.market);
    const testnet = networks.find((n) => n.network === "monad-testnet");
    expect(testnet).toMatchObject({ deployed: false, contracts: null, chainId: 10143 });
  });
});

describe("get_exit_capacity", () => {
  it("reports capacity in the underlying and bid capacity at five discount levels", async () => {
    const { net, ctx } = aave();
    vi.spyOn(net.sdk, "capacity").mockResolvedValue({
      withdrawable: 100_000n,
      supplied: 1_000_000_000n,
      utilizationBps: 9_999,
      debtorCapacity: 7_000_000n,
      sessionAssets: 0n,
    });
    const bidCapacityAt = vi
      .spyOn(net.sdk, "bidCapacityAt")
      .mockImplementation(async (d) => (d === 500 ? 500_000_000n : 0n));
    const res = await getExitCapacity(ctx, { network: "usdt0-replay" });
    expect(res.withdrawableNow).toEqual({ raw: "100000", human: "0.1", symbol: "USDT0" });
    expect(res.utilization).toEqual({ bps: 9_999, percent: "99.99%" });
    expect(bidCapacityAt.mock.calls.map(([d]) => d)).toEqual([100, 300, 500, 1_000, 2_000]);
    expect(CAPACITY_DISCOUNT_LEVELS).toEqual([100, 300, 500, 1_000, 2_000]);
    expect(res.bidCapacity[2]).toEqual({
      maxDiscount: { bps: 500, percent: "5.00%" },
      assets: { raw: "500000000", human: "500", symbol: "USDT0" },
    });
  });

  it("rejects an undeployed network", async () => {
    const { ctx } = aave();
    await expect(getExitCapacity(ctx, { network: "monad-testnet" })).rejects.toThrow(/No Selio deployment found/);
  });
});

describe("quote_purchase", () => {
  it("prices the purchase and shows the fee and the seller's net", async () => {
    const { net, ctx } = aave();
    vi.spyOn(net.sdk, "session").mockResolvedValue(session({ discountBps: 250 }));
    const quote = vi.spyOn(net.sdk, "quote").mockResolvedValue(4_875_000_000n);
    const res = await quotePurchase(ctx, { network: "usdt0-replay", sessionId: 1, assets: "2", payToken: "usdc" });
    expect(quote).toHaveBeenCalledWith(2_000_000n, 250, ADDR.USDC);
    expect(res.price).toEqual({ raw: "4875000000", human: "4875", symbol: "USDC" });
    expect(res.savings.human).toBe("0.05");
    expect(res.currentDiscount.percent).toBe("2.50%");
    expect(res.fee).toEqual({ raw: "9750000", human: "9.75", symbol: "USDC" });
    expect(res.sellerNet).toEqual({ raw: "4865250000", human: "4865.25", symbol: "USDC" });
    expect(res.notes.join(" ")).toMatch(/0\.20% of the price, rounded down/);
  });

  it("refuses pay tokens the session does not accept", async () => {
    const { net, ctx } = aave();
    vi.spyOn(net.sdk, "session").mockResolvedValue(session({ acceptedPayTokens: [ADDR.AUSD] }));
    await expect(
      quotePurchase(ctx, { network: "usdt0-replay", sessionId: "1", assets: "1", payToken: "USDC" }),
    ).rejects.toThrow(/does not accept USDC/);
    await expect(
      quotePurchase(ctx, { network: "usdt0-replay", sessionId: "1", assets: "1", payToken: "DAI" }),
    ).rejects.toThrow(/Accepted: AUSD/);
  });

  it("refuses more than the session has left", async () => {
    const { net, ctx } = aave();
    vi.spyOn(net.sdk, "session").mockResolvedValue(session({ remainingAssets: 1_000_000n }));
    await expect(
      quotePurchase(ctx, { network: "usdt0-replay", sessionId: 1, assets: "1.5", payToken: "USDT0" }),
    ).rejects.toThrow(/only has 1 USDT0 left/);
  });

  it("validates its input schema", () => {
    const schema = z.object(quotePurchaseShape);
    const ok = { network: "usdt0-replay", sessionId: 1, assets: "1", payToken: "USDC" };
    expect(schema.safeParse(ok).success).toBe(true);
    expect(schema.safeParse({ ...ok, network: "mainnet" }).success).toBe(false);
    expect(schema.safeParse({ ...ok, sessionId: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...ok, assets: "1e18" }).success).toBe(false);
  });
});

describe("list_bids", () => {
  it("flags the Selio Vault's bid and values escrow in the pay token", async () => {
    const { net, ctx } = aave();
    vi.spyOn(net.sdk, "bids").mockResolvedValue([
      bid({ id: 2n, bidder: ADDR.aaveVault, minDiscountBps: 200, payIdx: 2, payToken: ADDR.USDT0, escrow: 10_000_000n }),
      bid({ id: 3n }),
    ]);
    const res = await listBids(ctx, { network: "usdt0-replay" });
    expect(res.total).toBe(2);
    expect(res.bids[0]?.isSelioVault).toBe(true);
    expect(res.bids[1]?.isSelioVault).toBe(false);
    expect(res.bids[1]?.escrow).toEqual({ raw: "2000000000", human: "2000", symbol: "USDC" });
    expect(res.bids[1]?.buysUpTo.human).toBe("0.5");
    expect(res.nextCursor).toBeNull();
  });

  it("returns the book one page at a time", async () => {
    const { net, ctx } = aave();
    vi.spyOn(net.sdk, "bids").mockResolvedValue([bid({ id: 1n }), bid({ id: 2n }), bid({ id: 3n })]);
    const first = await listBids(ctx, { network: "usdt0-replay", limit: 2 });
    expect(first.bids.map((b) => b.bidId)).toEqual(["1", "2"]);
    expect(first).toMatchObject({ total: 3, nextCursor: "2" });
    const second = await listBids(ctx, { network: "usdt0-replay", limit: 2, cursor: "2" });
    expect(second.bids.map((b) => b.bidId)).toEqual(["3"]);
    expect(second.nextCursor).toBeNull();
    const past = await listBids(ctx, { network: "usdt0-replay", cursor: "9" });
    expect(past).toMatchObject({ bids: [], nextCursor: null, total: 3 });
    const schema = z.object(listBidsShape);
    expect(schema.safeParse({ network: "usdt0-replay", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ network: "usdt0-replay", limit: LIST_BIDS_MAX_LIMIT + 1 }).success).toBe(false);
    expect(schema.safeParse({ network: "usdt0-replay", cursor: "-1" }).success).toBe(false);
  });
});

describe("get_borrower_position", () => {
  it("shows a Morpho borrower's debt, health and collateral", async () => {
    const net = fakeNetwork(MORPHO_DEPLOYMENT);
    const ctx = { chain: fakeChain({ "vault-freeze": net.handle }) };
    vi.spyOn(net.sdk, "position").mockResolvedValue({
      debt: 5_000_000_000n,
      health: 1_500_000_000_000_000_000n,
      market: {
        loanToken: ADDR.morphoUSDC,
        collateralToken: ADDR.morphoWETH,
        oracle: ADDR.oracle,
        irm: ADDR.irm,
        lltv: 860_000_000_000_000_000n,
      },
      marketId: "0x409f2824aee2d8391d4a5924935e13312e157055e262b923b60c9dcb47e6311d",
      collateral: 20_000n * 10n ** 18n,
    });
    const res = await getBorrowerPosition(ctx, { network: "vault-freeze", address: ADDR.user.toLowerCase() });
    expect(res.address).toBe(ADDR.user);
    expect(res.debt).toEqual({ raw: "5000000000", human: "5000", symbol: "USDC" });
    expect(res.health).toBe("1.5");
    expect(res.collateral).toEqual({ raw: "20000000000000000000000", human: "20000", symbol: "WETH" });
    expect(res.notes[0]).toMatch(/can buy up to 5000 USDC/);
  });
});

describe("plan_sell_now", () => {
  it("plans fills with the fee and the seller's net per pay token", async () => {
    const { net, ctx } = aave();
    const plan: SellPlan = {
      bidIds: [3n],
      fills: [
        {
          bidId: 3n,
          assets: 1_000_000n,
          pay: 1_900_000_000n,
          fee: 3_800_000n,
          sellerNet: 1_896_200_000n,
          payToken: ADDR.USDC,
          discountBps: 500,
        },
      ],
      filledAssets: 1_000_000n,
      proceeds: { [ADDR.USDC]: 1_900_000_000n },
      fees: { [ADDR.USDC]: 3_800_000n },
      sellerNet: { [ADDR.USDC]: 1_896_200_000n },
      averageDiscountBps: 500,
    };
    const planSell = vi.spyOn(net.sdk, "planSellNow").mockResolvedValue(plan);
    const res = await planSellNow(ctx, {
      network: "usdt0-replay",
      assets: "3",
      maxDiscountBps: 600,
      payTokens: ["USDC", ADDR.WETH],
    });
    expect(planSell).toHaveBeenCalledWith(3_000_000n, 600, 0b1010);
    expect(res.unfilled.human).toBe("2");
    expect(res.proceeds).toEqual([{ raw: "1900000000", human: "1900", symbol: "USDC" }]);
    expect(res.fees).toEqual([{ raw: "3800000", human: "3.8", symbol: "USDC" }]);
    expect(res.sellerNet).toEqual([{ raw: "1896200000", human: "1896.2", symbol: "USDC" }]);
    expect(res.fills[0]).toMatchObject({ bidId: "3", fee: { human: "3.8" }, sellerNet: { human: "1896.2" } });
    expect(res.notes.join(" ")).toMatch(/open a Dutch-auction session/);
  });

  it("caps the discount at the contract maximum", () => {
    const schema = z.object(planSellNowShape);
    expect(schema.safeParse({ network: "usdt0-replay", assets: "1", maxDiscountBps: 5_000 }).success).toBe(true);
    expect(schema.safeParse({ network: "usdt0-replay", assets: "1", maxDiscountBps: 5_001 }).success).toBe(false);
  });
});

/* ------------------------------ Kuru ------------------------------ */

function kuruAave() {
  const net = fakeNetwork(KURU_AAVE_DEPLOYMENT);
  vi.spyOn(net.sdk, "kuruMarket").mockResolvedValue(KURU_MARKET);
  return { net, ctx: { chain: fakeChain({ "usdt0-replay": net.handle }) } };
}

function frozenCapacity(net: ReturnType<typeof kuruAave>["net"]) {
  vi.spyOn(net.sdk, "capacity").mockResolvedValue({
    withdrawable: 0n,
    supplied: 123_720_197_000_000n,
    utilizationBps: 10_000,
    debtorCapacity: 120_000_000_000_000n,
    sessionAssets: 0n,
  });
  vi.spyOn(net.sdk, "bidCapacityAt").mockResolvedValue(0n);
}

const level = (price: number, faceAssets: bigint, discountBps: number): KuruLevel => ({
  price,
  size: faceAssets,
  baseAmount: faceAssets,
  faceAssets,
  discountBps,
  netPerFaceWad: 0n,
});

describe("plan_sell_now with Kuru", () => {
  it("routes between Selio's bids and the Kuru book on a Kuru network", async () => {
    const { net, ctx } = kuruAave();
    const routed = vi.spyOn(net.sdk, "planRoutedSell").mockResolvedValue(ROUTED_SALE);
    const selioOnly = vi.spyOn(net.sdk, "planSellNow");
    const res = await planSellNow(ctx, {
      network: "usdt0-replay",
      assets: "120",
      maxDiscountBps: 5_000,
      payTokens: ["USDT0"],
    });
    expect(routed).toHaveBeenCalledWith(120_000_000n, 5_000, 0b0100);
    expect(selioOnly).not.toHaveBeenCalled();
    expect(res.route).toBe("selio+kuru");
    expect(res.filled).toEqual({ raw: "120000000", human: "120", symbol: "USDT0" });
    expect(res.unfilled.raw).toBe("0");
    expect(res.averageDiscount).toEqual({ bps: 267, percent: "2.67%" });
    expect(res.kuru).toEqual({
      receiptAssets: { raw: "50108201", human: "50.108201", symbol: "USDT0" },
      base: { raw: "50000000", human: "50", symbol: "waMonUSDT0" },
      size: "50000000",
      expectedOut: { raw: "49000000", human: "49", symbol: "USDT0" },
      minOut: { raw: "48755000", human: "48.755", symbol: "USDT0" },
      averageDiscountBps: 221,
      takerFeeBps: 0,
    });
    expect(res.fills).toHaveLength(1);
    expect(res.sellerNet).toEqual([{ raw: "67659456", human: "67.659456", symbol: "USDT0" }]);
    expect(res.notes.join(" ")).toMatch(/Selio's fee applies only to the Selio part; the Kuru part pays Kuru's own taker fee/);
  });

  it("keeps to Selio's bids with useKuru false, and on networks without a Kuru market", async () => {
    const empty: SellPlan = { ...SELIO_LEG, fills: [], bidIds: [], filledAssets: 0n, proceeds: {}, fees: {}, sellerNet: {} };
    const { net, ctx } = kuruAave();
    const routed = vi.spyOn(net.sdk, "planRoutedSell");
    vi.spyOn(net.sdk, "planSellNow").mockResolvedValue(empty);
    const res = await planSellNow(ctx, { network: "usdt0-replay", assets: "1", maxDiscountBps: 500, useKuru: false });
    expect(routed).not.toHaveBeenCalled();
    expect(res).not.toHaveProperty("route");
    expect(res).not.toHaveProperty("kuru");
    const plain = aave();
    vi.spyOn(plain.net.sdk, "planSellNow").mockResolvedValue(empty);
    const routedPlain = vi.spyOn(plain.net.sdk, "planRoutedSell");
    const res2 = await planSellNow(plain.ctx, { network: "usdt0-replay", assets: "1", maxDiscountBps: 500 });
    expect(routedPlain).not.toHaveBeenCalled();
    expect(res2).not.toHaveProperty("kuru");
  });

  it("explains a route that stays on Selio's bids", async () => {
    const { net, ctx } = kuruAave();
    vi.spyOn(net.sdk, "planRoutedSell").mockResolvedValue({
      ...ROUTED_SALE,
      kuru: null,
      route: "selio",
      filledAssets: 69_891_800n,
    });
    const res = await planSellNow(ctx, { network: "usdt0-replay", assets: "120", maxDiscountBps: 5_000 });
    expect(res.route).toBe("selio");
    expect(res.kuru).toBeNull();
    expect(res.notes.join(" ")).toMatch(/Kuru order book pays no more than Selio's bids/);
    expect(res.notes.join(" ")).toMatch(/Escrowed bids and the Kuru book cannot absorb the full amount/);
  });

  it("accepts useKuru in its input schema", () => {
    const schema = z.object(planSellNowShape);
    expect(schema.safeParse({ network: "usdt0-replay", assets: "1", maxDiscountBps: 100, useKuru: false }).success).toBe(
      true,
    );
    expect(schema.safeParse({ network: "usdt0-replay", assets: "1", maxDiscountBps: 100, useKuru: "no" }).success).toBe(
      false,
    );
  });
});

describe("get_exit_capacity with Kuru", () => {
  it("adds the Kuru book of the receipt as the market's risk data", async () => {
    const { net, ctx } = kuruAave();
    frozenCapacity(net);
    vi.spyOn(net.sdk, "kuruFacePerBase").mockResolvedValue(1_002_164n);
    vi.spyOn(net.sdk, "kuruBook").mockResolvedValue([
      level(972_000, 10_000_000_000n, 300),
      level(950_000, 2_000_000n, 520),
      level(400_000, 9_000_000n, 6_008),
    ]);
    const res = await getExitCapacity(ctx, { network: "usdt0-replay" });
    expect(res.kuru).toEqual({
      market: ADDR.kuruBook,
      facePerBase: { raw: "1002164", human: "1.002164", symbol: "USDT0" },
      bestBidDiscountBps: 300,
      depthAssets: { raw: "10002000000", human: "10002", symbol: "USDT0" },
      levels: [
        {
          price: "0.972",
          discount: { bps: 300, percent: "3.00%" },
          faceAssets: { raw: "10000000000", human: "10000", symbol: "USDT0" },
        },
        {
          price: "0.95",
          discount: { bps: 520, percent: "5.20%" },
          faceAssets: { raw: "2000000", human: "2", symbol: "USDT0" },
        },
        {
          price: "0.4",
          discount: { bps: 6_008, percent: "60.08%" },
          faceAssets: { raw: "9000000", human: "9", symbol: "USDT0" },
        },
      ],
    });
    expect(res.notes.join(" ")).toMatch(/not part of bidCapacity/);
    const plain = aave();
    frozenCapacity(plain.net);
    expect(await getExitCapacity(plain.ctx, { network: "usdt0-replay" })).not.toHaveProperty("kuru");
  });

  it("reports no best bid on an empty Kuru book", async () => {
    const { net, ctx } = kuruAave();
    frozenCapacity(net);
    vi.spyOn(net.sdk, "kuruFacePerBase").mockResolvedValue(1_002_164n);
    vi.spyOn(net.sdk, "kuruBook").mockResolvedValue([]);
    const res = await getExitCapacity(ctx, { network: "usdt0-replay" });
    expect(res.kuru).toMatchObject({ bestBidDiscountBps: null, depthAssets: { raw: "0" }, levels: [] });
  });
});
