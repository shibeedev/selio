import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { KuruMarketInfo, SelioClient } from "@selio/sdk";
import { kuruSaleFill, sellNowRows, summarizeFills, type SellerFill } from "./history";
import { kuruBidPlan, kuruPriceText, loadKuruOrders, ROUTE_LABEL, routedFeeLabel } from "./kuru";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const USDT0 = { address: a(1), symbol: "USDT0", decimals: 6 };
const WRAPPED = { address: a(2), symbol: "waMonUSDT0", decimals: 6 };

// The USDT0 replay market of the build reference (§10.2 D.1), with the face value at the replay block.
const M: KuruMarketInfo = {
  book: a(9),
  base: WRAPPED,
  quote: USDT0,
  wrapper: a(2),
  pricePrecision: 1_000_000,
  sizePrecision: 1_000_000n,
  tickSize: 100,
  minSize: 1_000_000n,
  maxSize: 10n ** 15n,
  takerFeeBps: 0,
  makerFeeBps: 0,
};
const FACE = 1_002_164n;

describe("routed sell-now preview", () => {
  it("names each route", () => {
    expect(ROUTE_LABEL.selio).toBe("Selio bids");
    expect(ROUTE_LABEL["selio+kuru"]).toBe("Selio bids and Kuru order book");
    expect(ROUTE_LABEL.kuru).toBe("Kuru order book");
  });

  it("states that Selio's fee applies to the Selio part only", () => {
    expect(routedFeeLabel(20, 0)).toBe("Selio fee 0.2% on the Selio part; Kuru's own fee on the Kuru part (0%)");
    expect(routedFeeLabel(20, 15)).toBe("Selio fee 0.2% on the Selio part; Kuru's own fee on the Kuru part (0.15%)");
  });

  it("shows a Kuru price as quote per whole base unit", () => {
    expect(kuruPriceText(972_000, M)).toBe("0.972 USDT0");
  });
});

describe("Kuru limit bid", () => {
  it("prices, sizes and funds a bid as the worked example", () => {
    // 10,000 USDT0 of face at 3% at least: price 0.972, size 9,978.406727, debit 9,699.011339 USDT0.
    expect(kuruBidPlan(10_000_000_000n, 300, FACE, M)).toEqual({
      price: 972_000,
      size: 9_978_406_727n,
      debit: 9_699_011_339n,
      error: null,
    });
  });

  it("never prices above the chosen discount", () => {
    const { price } = kuruBidPlan(5_000_000n, 250, FACE, M);
    expect(price % M.tickSize).toBe(0);
    expect(BigInt(price) * 10_000n).toBeLessThanOrEqual(FACE * 9_750n);
  });

  it("refuses a bid below the market's minimum size", () => {
    const plan = kuruBidPlan(500_000n, 300, FACE, M);
    expect(plan.size).toBeLessThan(M.minSize);
    expect(plan.error).toBe("Kuru needs at least 1 USDT0 of face value per order");
  });
});

describe("the user's Kuru orders", () => {
  const ME = a(77);
  // Orders 1 to 4: 1 is someone else's, 2 is ours and filled (the price's queue head moved past it), 3 is ours and
  // resting, 4 was cancelled (its record is deleted).
  const orders: Record<number, readonly [Address, bigint, number, number, number, number, number, boolean]> = {
    1: [a(55), 5_000_000n, 0, 0, 0, 970_000, 0, true],
    2: [ME, 2_000_000n, 0, 0, 0, 960_000, 0, true],
    3: [ME, 3_000_000n, 0, 0, 0, 950_000, 0, true],
    4: ["0x0000000000000000000000000000000000000000", 0n, 0, 0, 0, 0, 0, false],
  };
  const heads: Record<string, number> = { "960000": 3, "950000": 3 };
  const selio = {
    deployment: { kuruMarket: a(9) },
    client: {
      readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "s_orderIdCounter") return 4;
        if (functionName === "s_orders") return orders[Number(args?.[0])];
        if (functionName === "s_buyPricePoints") return [heads[String(args?.[0])] ?? 0, 0];
        throw new Error(`unexpected ${functionName}`);
      },
    },
  } as unknown as SelioClient;

  it("lists only the account's buy orders, newest first, with their status", async () => {
    expect(await loadKuruOrders(selio, ME)).toEqual([
      { id: 3n, price: 950_000, remainingSize: 3_000_000n, status: "active" },
      { id: 2n, price: 960_000, remainingSize: 0n, status: "filled" },
    ]);
  });
});

describe("routed sale history", () => {
  const TX = `0x${"ab".repeat(32)}` as Hex;
  const bidFill = (assets: bigint, paid: bigint, discountBps: number, txHash: Hex | null = TX): SellerFill => ({
    sessionId: 0n,
    assets,
    paid,
    fee: (paid * 20n) / 10_000n,
    payToken: USDT0.address,
    discountBps,
    txHash,
    via: "bid",
  });

  it("books the Kuru part at what Kuru paid, with no Selio fee", () => {
    expect(kuruSaleFill({ kuruAssets: 50_108_200n, kuruOut: 49_000_000n, txHash: TX }, USDT0.address)).toEqual({
      sessionId: 0n,
      assets: 50_108_200n,
      paid: 49_000_000n,
      fee: 0n,
      payToken: USDT0.address,
      discountBps: 221,
      txHash: TX,
      via: "kuru",
    });
    expect(kuruSaleFill({ kuruAssets: 0n, kuruOut: 0n, txHash: TX }, USDT0.address)).toBeNull();
  });

  it("groups a routed sale's bid fills and its Kuru part into one row", () => {
    const kuru = kuruSaleFill({ kuruAssets: 50_108_200n, kuruOut: 49_000_000n, txHash: TX }, USDT0.address) as SellerFill;
    const other = `0x${"cd".repeat(32)}` as Hex;
    const rows = sellNowRows([
      bidFill(69_891_800n, 67_795_046n, 300),
      kuru,
      bidFill(1_000_000n, 980_000n, 200, other),
      { ...bidFill(5_000_000n, 4_900_000n, 200), sessionId: 4n },
    ]);
    expect(rows.map((r) => [r.key, r.label, r.fills.length])).toEqual([
      [TX, "Sold now to bids and Kuru", 2],
      [other, "Sold now to bids", 1],
    ]);
    const summary = summarizeFills(rows[0]?.fills ?? []);
    expect(summary.assets).toBe(120_000_000n);
    // The Selio fill nets its 0.2% fee; the Kuru part arrives whole.
    expect(summary.received).toEqual([{ token: USDT0.address, amount: 67_795_046n - 135_590n + 49_000_000n }]);
    expect(sellNowRows([kuru])[0]?.label).toBe("Sold now on Kuru");
  });
});
