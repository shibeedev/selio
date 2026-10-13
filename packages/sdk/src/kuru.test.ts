import { describe, expect, it } from "vitest";
import {
  concat,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  pad,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  SelioClient,
  decodeL2Bids,
  displacedValue,
  kuruBaseForFace,
  kuruDebit,
  kuruDiscountOfPrice,
  kuruLevels,
  kuruMinOut,
  kuruOrderBookAbi,
  kuruParPrice,
  kuruPriceForDiscount,
  kuruSellRouterAbi,
  kuruSizeForFace,
  mergeRoute,
  parseDeployment,
  selioNetPerFaceWad,
  selioVaultAbi,
  type Deployment,
  type KuruMarketInfo,
} from "./index.js";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const USDT0 = addr(3);
const WRAPPER = addr(30);
const BOOK = addr(31);
const ROUTER = addr(32);
const MARGIN = addr(33);
/** waMonUSDT0 face value of one share at block 94,027,500. */
const F = 1_002_164n;

const KURU_KEYS = {
  kuruRouter: addr(34),
  kuruMarginAccount: MARGIN,
  kuruMarket: BOOK,
  kuruBase: WRAPPER,
  kuruWrapper: WRAPPER,
  kuruSellRouter: ROUTER,
};

const REPLAY: Deployment = {
  network: "usdt0-replay",
  chainId: 143,
  deployBlock: 1,
  venue: "aave",
  market: addr(1),
  receipt: addr(2),
  underlying: USDT0,
  priceRouter: addr(4),
  selioVault: addr(5),
  payTokens: [addr(10), addr(11), USDT0, addr(12)],
  aavePool: addr(6),
  debtToken: addr(7),
  collateralRoute: addr(8),
  ...KURU_KEYS,
};

/** The usdt0-replay market: waMonUSDT0 / USDT0, both 6 decimals. */
const MARKET: KuruMarketInfo = {
  book: BOOK,
  base: { address: WRAPPER, symbol: "waMonUSDT0", decimals: 6 },
  quote: { address: USDT0, symbol: "USDT0", decimals: 6 },
  wrapper: WRAPPER,
  pricePrecision: 1_000_000,
  sizePrecision: 1_000_000n,
  tickSize: 100,
  minSize: 1_000_000n,
  maxSize: 10n ** 15n,
  takerFeeBps: 0,
  makerFeeBps: 0,
};

/** Kuru's getL2Book bytes: block number, bid (price, size) pairs best first, a zero word, then ask pairs. */
function l2Book(block: bigint, bids: [bigint, bigint][], asks: [bigint, bigint][] = []): Hex {
  const words = [block, ...bids.flat(), 0n, ...asks.flat()];
  return concat(words.map((w) => pad(toHex(w), { size: 32 })));
}

type Handler = (args: readonly unknown[], address: Address) => unknown;

interface Bid {
  minDiscountBps: number;
  payIdx: number;
  capacity: bigint;
}

/**
 * A PublicClient stand-in for a usdt0-replay deployment: Selio bids, a Kuru book of `levels`, and Kuru's zero-address
 * quote answered by `kuruOut(size)`.
 */
function kuruClient(bids: Bid[], levels: [bigint, bigint][], kuruOut: (size: bigint) => bigint, extra: Record<string, Handler> = {}) {
  const calls: Hex[] = [];
  const handlers: Record<string, Handler> = {
    activeBidIdsPage: ([offset]) => ((offset as bigint) === 0n ? bids.map((_, i) => BigInt(i + 1)) : []),
    bids: ([id]) => {
      const b = bids[Number(id) - 1] as Bid;
      return [addr(40), b.minDiscountBps, b.payIdx, b.capacity, b.capacity];
    },
    bidCapacity: ([id]) => (bids[Number(id) - 1] as Bid).capacity,
    FEE_BPS: () => 20,
    // Bids pay in the underlying, so the market's quote is ⌈assets × (10,000 − d) / 10,000⌉.
    quote: ([assets, d]) => ((assets as bigint) * (10_000n - BigInt(d as number)) + 9_999n) / 10_000n,
    getMarketParams: () => [1_000_000, 1_000_000n, WRAPPER, 6n, USDT0, 6n, 100, 1_000_000n, 10n ** 15n, 0n, 0n],
    symbol: (_args, address) => (address === WRAPPER ? "waMonUSDT0" : "USDT0"),
    decimals: () => 6,
    convertToAssets: ([shares]) => ((shares as bigint) * F) / 1_000_000n,
    getL2Book: () => l2Book(94_027_500n, levels),
    ...extra,
  };
  const client = {
    async readContract({ address, functionName, args = [] }: { address: Address; functionName: string; args?: readonly unknown[] }) {
      const handler = handlers[functionName];
      if (!handler) throw new Error(`unexpected read ${functionName}`);
      return handler(args, address);
    },
    async call({ account, to, data }: { account: Address; to: Address; data: Hex }) {
      expect(account).toBe(zeroAddress);
      expect(to).toBe(BOOK);
      calls.push(data);
      const { args } = decodeFunctionData({ abi: kuruOrderBookAbi, data });
      const size = (args as readonly [bigint, bigint, boolean, boolean])[0];
      return {
        data: encodeFunctionResult({ abi: kuruOrderBookAbi, functionName: "placeAndExecuteMarketSell", result: kuruOut(size) }),
      };
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

/** Kuru's quote for a market sell into one level at `price` (taker fee 0). */
const fillAt = (price: bigint) => (size: bigint) => (size * price) / 1_000_000n;

describe("decodeL2Bids", () => {
  it("decodes a book recorded at block 94,027,500: one bid of 2 waMonUSDT0 at 0.97", () => {
    const recorded: Hex =
      "0x00000000000000000000000000000000000000000000000000000000059abeec00000000000000000000000000000000000000000000000000000000000ecd1000000000000000000000000000000000000000000000000000000000001e84800000000000000000000000000000000000000000000000000000000000000000";
    expect(decodeL2Bids(recorded)).toEqual([{ price: 970_000, size: 2_000_000n }]);
  });

  it("stops at the zero word before the asks", () => {
    const data = l2Book(7n, [
      [980_000n, 50_000_000n],
      [960_000n, 3_000_000n],
    ], [[1_010_000n, 9n]]);
    expect(decodeL2Bids(data)).toEqual([
      { price: 980_000, size: 50_000_000n },
      { price: 960_000, size: 3_000_000n },
    ]);
    expect(decodeL2Bids(l2Book(7n, [], [[1_010_000n, 9n]]))).toEqual([]);
  });
});

describe("Kuru price and discount", () => {
  it("converts between Kuru prices and discounts below face", () => {
    expect(kuruParPrice(F, MARKET)).toBe(1_002_164);
    expect(kuruPriceForDiscount(300, F, MARKET)).toBe(972_000);
    expect(kuruDiscountOfPrice(972_000, F, MARKET)).toBe(300);
    expect(kuruDiscountOfPrice(980_000, F, MARKET)).toBe(221);
    expect(kuruDiscountOfPrice(1_010_000, F, MARKET)).toBe(0);
    for (const d of [0, 1, 99, 300, 517, 2_000, 5_000]) {
      const price = kuruPriceForDiscount(d, F, MARKET);
      expect(price % MARKET.tickSize).toBe(0);
      expect(kuruDiscountOfPrice(price, F, MARKET)).toBeGreaterThanOrEqual(d);
    }
  });

  it("sizes a Kuru bid for a face value and prices its debit like Kuru", () => {
    expect(kuruSizeForFace(10_000_000_000n, F, MARKET)).toBe(9_978_406_727n);
    expect(kuruDebit(972_000, 9_978_406_727n, MARKET)).toBe(9_699_011_339n);
    expect(kuruSizeForFace(10n ** 30n, F, MARKET)).toBe(MARKET.maxSize);
  });

  it("values each level per unit of face, net of Kuru's taker fee", () => {
    const [level] = kuruLevels([{ price: 980_000, size: 50_000_000n }], F, MARKET);
    expect(level).toMatchObject({ price: 980_000, baseAmount: 50_000_000n, faceAssets: 50_108_200n, discountBps: 221 });
    expect(level?.netPerFaceWad).toBe(977_883_859_328_413_313n);
    const [withFee] = kuruLevels([{ price: 980_000, size: 50_000_000n }], F, { ...MARKET, takerFeeBps: 30 });
    expect(withFee?.netPerFaceWad).toBe(974_950_207_750_428_073n);
    expect(selioNetPerFaceWad(300, 20)).toBe(968_060_000_000_000_000n);
  });
});

describe("routing merge", () => {
  it("gives a tie to Selio", () => {
    const market = { ...MARKET, tickSize: 1 };
    // One whole base unit is worth 1 underlying: a price of 968,060 nets exactly what a 3% Selio bid nets after 0.2%.
    const [level] = kuruLevels([{ price: 968_060, size: 10_000_000n }], 1_000_000n, market);
    expect(level?.netPerFaceWad).toBe(selioNetPerFaceWad(300, 20));
    const takes = mergeRoute(15_000_000n, [{ discountBps: 300, capacity: 10_000_000n }], [level!], 20);
    expect(takes).toEqual({ selio: [10_000_000n], kuru: [5_000_000n] });
  });

  it("values what the Kuru leg displaces from the unused Selio bids, best first", () => {
    const selio = [
      { discountBps: 300, capacity: 100_000_000n },
      { discountBps: 500, capacity: 20_000_000n },
    ];
    expect(displacedValue(50_108_200n, selio, [30_108_200n, 20_000_000n], 20)).toBe(48_108_545n);
    expect(displacedValue(10_000_000n, selio, [0n, 20_000_000n], 20)).toBe(9_481_000n);
    expect(kuruMinOut(49_000_000n, 48_108_545n, 50)).toBe(48_755_000n);
    expect(kuruMinOut(48_200_000n, 48_108_545n, 50)).toBe(48_108_546n);
  });

  it("rounds the Kuru leg down to the market's size grain", () => {
    expect(kuruBaseForFace(50_108_200n, F, MARKET)).toBe(50_000_000n);
    expect(kuruBaseForFace(1_234_567n, F, MARKET)).toBe(1_231_901n);
    // eUSDC: 18-decimal Vault V2 shares at size precision 1e6, so the grain is 1e12 share wei.
    const shares: KuruMarketInfo = {
      ...MARKET,
      base: { address: addr(20), symbol: "eUSDC", decimals: 18 },
      wrapper: zeroAddress,
    };
    expect(kuruBaseForFace(1_234_567n, 1_000_000n, shares)).toBe(1_234_567n * 10n ** 12n);
    const base = kuruBaseForFace(1_234_567n, 1_041_902n, shares);
    expect(base % 10n ** 12n).toBe(0n);
    expect(base).toBe(1_184_916n * 10n ** 12n);
    expect(base).toBeLessThanOrEqual((1_234_567n * 10n ** 18n) / 1_041_902n);
  });
});

describe("planRoutedSell", () => {
  const bids: Bid[] = [
    { minDiscountBps: 300, payIdx: 2, capacity: 100_000_000n },
    { minDiscountBps: 500, payIdx: 2, capacity: 20_000_000n },
  ];

  it("reproduces the worked example: the Kuru level at 0.98 beats both Selio bids", async () => {
    const { client, calls } = kuruClient(bids, [[980_000n, 50_000_000n]], fillAt(980_000n));
    const plan = await new SelioClient(REPLAY, client).planRoutedSell(120_000_000n, 5_000, 0b0100);
    expect(plan.route).toBe("selio+kuru");
    expect(plan.filledAssets).toBe(120_000_000n);
    expect(plan.kuru).toEqual({
      receiptAssets: 50_108_201n,
      baseAmount: 50_000_000n,
      size: 50_000_000n,
      expectedOut: 49_000_000n,
      minOut: 48_755_000n,
      displacedValue: 48_108_545n,
      levels: [{ price: 980_000, faceAssets: 50_108_200n }],
    });
    expect(plan.selio.bidIds).toEqual([1n]);
    expect(plan.selio.fills).toEqual([
      {
        bidId: 1n,
        assets: 69_891_800n,
        pay: 67_795_046n,
        fee: 135_590n,
        sellerNet: 67_659_456n,
        payToken: USDT0,
        discountBps: 300,
      },
    ]);
    expect(plan.averageDiscountBps).toBe(267);
    expect(plan.netValue).toBe(116_659_456n);
    expect(calls).toHaveLength(1);
  });

  it("gains over the Selio-only plan of the same sale", async () => {
    const { client } = kuruClient(bids, [], () => 0n);
    const selioOnly = await new SelioClient(REPLAY, client).planRoutedSell(120_000_000n, 5_000, 0b0100);
    expect(selioOnly.route).toBe("selio");
    expect(selioOnly.kuru).toBeNull();
    expect(selioOnly.netValue).toBe(115_768_000n);
    expect(116_659_456n - selioOnly.netValue).toBe(891_456n);
  });

  it("drops the Kuru leg when it would not pay more than the Selio bids it displaces", async () => {
    // The book shows 0.98, but the executable quote is only what the displaced bids would pay.
    const { client } = kuruClient(bids, [[980_000n, 50_000_000n]], () => 48_108_545n);
    const plan = await new SelioClient(REPLAY, client).planRoutedSell(120_000_000n, 5_000, 0b0100);
    expect(plan.route).toBe("selio");
    expect(plan.kuru).toBeNull();
    expect(plan.selio.fills.map((f) => f.assets)).toEqual([100_000_000n, 20_000_000n]);
    expect(plan.netValue).toBe(115_768_000n);
  });

  it("routes everything to Kuru when Selio has no bid within the seller's limits", async () => {
    const { client } = kuruClient(bids, [[980_000n, 50_000_000n]], fillAt(980_000n));
    const plan = await new SelioClient(REPLAY, client).planRoutedSell(10_000_000n, 250, 0b0100);
    expect(plan.route).toBe("kuru");
    expect(plan.selio.filledAssets).toBe(0n);
    expect(plan.kuru?.baseAmount).toBe(9_978_406n);
    expect(plan.kuru?.minOut).toBe((plan.kuru!.expectedOut * 9_950n) / 10_000n);
  });

  it("ignores Kuru levels deeper than the seller's maximum discount", async () => {
    const { client, calls } = kuruClient(bids, [[900_000n, 50_000_000n]], fillAt(900_000n));
    const plan = await new SelioClient(REPLAY, client).planRoutedSell(10_000_000n, 500, 0b0100);
    expect(plan.route).toBe("selio");
    expect(calls).toHaveLength(0);
  });

  it("builds the router transaction with the plan's two legs", async () => {
    const { client } = kuruClient(bids, [[980_000n, 50_000_000n]], fillAt(980_000n));
    const sdk = new SelioClient(REPLAY, client);
    const plan = await sdk.planRoutedSell(120_000_000n, 5_000, 0b0100);
    const tx = sdk.routedSell(plan, addr(77));
    expect(tx.to).toBe(ROUTER);
    expect(tx.description).toBe("Sell receipts now: Selio bids and the Kuru order book, best price per unit");
    const { functionName, args } = decodeFunctionData({ abi: kuruSellRouterAbi, data: tx.data });
    expect(functionName).toBe("sell");
    expect(args[0]).toEqual({
      selioAssets: 69_891_800n,
      bidIds: [1n],
      maxDiscountBps: 5_000,
      payMask: 0b0100,
      selioMinFilled: 69_891_800n,
      kuruAssets: 50_108_201n,
      kuruMinOut: 48_755_000n,
      to: addr(77),
    });
    // Aave: aToken values plus 10 wei for each transfer (one per Selio fill, the pull and the wrap).
    expect(await sdk.routedSellApproval(plan)).toBe(69_891_800n + 50_108_201n + 30n);
  });
});

describe("Kuru builders and deployment keys", () => {
  const sdk = new SelioClient(REPLAY, kuruClient([], [], () => 0n).client);

  it("encodes the margin account and order book calls", () => {
    const deposit = sdk.kuruDeposit(USDT0, addr(9), 1_000_000n);
    expect(deposit.to).toBe(MARGIN);
    expect(deposit.description).toBe("Deposit into your Kuru margin account so an order can use it");
    const bid = sdk.kuruPlaceBid(972_000, 2_000_000n);
    expect(bid.to).toBe(BOOK);
    expect(decodeFunctionData({ abi: kuruOrderBookAbi, data: bid.data }).args).toEqual([972_000, 2_000_000n, true]);
    expect(bid.description).toBe("Place a limit bid for receipts on the Kuru order book");
    const cancel = sdk.kuruCancel([3n, 9n]);
    expect(decodeFunctionData({ abi: kuruOrderBookAbi, data: cancel.data })).toMatchObject({
      functionName: "batchCancelOrdersNoRevert",
      args: [[3, 9]],
    });
    expect(cancel.description).toBe("Cancel your Kuru bids; unused funds return to your Kuru margin account");
    const withdraw = sdk.kuruWithdraw(WRAPPER, 5n);
    expect(withdraw.to).toBe(MARGIN);
    expect(withdraw.description).toBe("Withdraw from your Kuru margin account to your wallet");
  });

  it("throws on a network without a Kuru market", async () => {
    const { kuruRouter, kuruMarginAccount, kuruMarket, kuruBase, kuruWrapper, kuruSellRouter, ...noKuru } = REPLAY;
    const plain = new SelioClient(noKuru, kuruClient([], [], () => 0n).client);
    await expect(plain.kuruBook()).rejects.toThrow("Kuru is not configured on this network");
    expect(() => plain.kuruPlaceBid(972_000, 1n)).toThrow("Kuru is not configured on this network");
  });

  it("treats the six Kuru keys as one group", () => {
    const { kuruSellRouter, ...partial } = REPLAY;
    expect(() => parseDeployment(partial)).toThrow("deployment usdt0-replay: missing kuru keys");
    expect(() => parseDeployment({ ...REPLAY, kuruWrapper: "none" })).toThrow("missing kuru keys");
    expect(parseDeployment({ ...REPLAY, kuruWrapper: zeroAddress }).kuruWrapper).toBe(zeroAddress);
    const { kuruRouter, kuruMarginAccount, kuruMarket, kuruBase, kuruWrapper, ...noKuru } = partial;
    expect(parseDeployment(noKuru).kuruMarket).toBeUndefined();
  });
});

describe("vaultState on a Kuru network", () => {
  it("reports the vault's standing Kuru bid and a resolved claim", async () => {
    const owner = addr(60);
    const claim: unknown[] = [];
    const { client } = kuruClient([], [], () => 0n, {
      totalAssets: () => 100_000_000_000n,
      idleAssets: () => 100_000_000_000n,
      heldAssets: () => 0n,
      totalSupply: () => 10n ** 17n,
      decimals: (_args, address) => (address === REPLAY.selioVault ? 9 : 6),
      bidOf: () => 1n,
      yieldSource: () => zeroAddress,
      strategy: () => ({ market: addr(1), receipt: addr(2), minDiscountBps: 300, maxShareBps: 2_000, payIdx: 2 }),
      balanceOf: () => 10n ** 15n,
      previewRedeem: () => [1n, [0n], 0n],
      kuruLeg: () => [BOOK, MARGIN, WRAPPER, 4, 972_000, 9_978_406_727n, 9_699_011_339n, 0n],
      kuruOrderState: () => [true, 4_978_406_727n, 4_839_011_338n, 4_860_000_001n],
      kuruClaimOf: () => [0n, 10n ** 16n],
    });
    const stubbed = client as unknown as Record<string, unknown>;
    stubbed.simulateContract = async (req: { functionName: string; args: unknown[]; account: Address }) => {
      claim.push(req);
      return { result: [5_000n, 7_000n] };
    };
    const state = await new SelioClient(REPLAY, client).vaultState(owner);
    expect(state.kuru).toEqual({
      orderId: 4n,
      price: 972_000,
      discountBps: 300,
      remainingSize: 4_978_406_727n,
      faceAssets: (4_978_406_727n * F) / 1_000_000n,
      escrow: 9_699_011_339n,
      pendingCost: 4_860_000_001n,
      claimable: { wad: 10n ** 16n, resolved: true, cash: 5_000n, receipts: 7_000n },
    });
    expect(claim).toMatchObject([{ functionName: "claimKuru", args: [0n, owner], account: owner }]);
  });

  it("encodes the vault's Kuru claim", () => {
    const sdk = new SelioClient(REPLAY, kuruClient([], [], () => 0n).client);
    const tx = sdk.vaultClaimKuru(addr(61));
    expect(tx.to).toBe(REPLAY.selioVault);
    expect(decodeFunctionData({ abi: selioVaultAbi, data: tx.data })).toMatchObject({
      functionName: "claimKuru",
      args: [0n, addr(61)],
    });
  });
});
