import { describe, expect, it } from "vitest";
import {
  concat,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  maxUint256,
  parseAbiParameters,
  recoverAddress,
  size,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aaveExitMarketAbi,
  formatBps,
  formatUnitsShort,
  morphoMarketId,
  morphoVaultExitMarketAbi,
  parseDeployment,
  selioVaultAbi,
  SelioClient,
  type Deployment,
  type SellPlan,
} from "./index.js";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

const AAVE: Deployment = {
  network: "usdt0-replay",
  chainId: 143,
  deployBlock: 1,
  venue: "aave",
  market: addr(1),
  receipt: addr(2),
  underlying: addr(3),
  priceRouter: addr(4),
  selioVault: addr(5),
  payTokens: [addr(10), addr(11), addr(3), addr(12)],
  aavePool: addr(6),
  debtToken: addr(7),
  collateralRoute: addr(8),
};

const MORPHO: Deployment = {
  network: "vault-freeze",
  chainId: 143,
  deployBlock: 1,
  venue: "morpho",
  market: addr(1),
  receipt: addr(20),
  underlying: addr(3),
  priceRouter: addr(4),
  selioVault: addr(5),
  payTokens: [addr(3), addr(12)],
  morpho: addr(21),
  earnVault: addr(20),
  adapter: addr(22),
  collateral: addr(12),
};

type Read = { address: Address; functionName: string; args: readonly unknown[] };
type Handler = (args: readonly unknown[], address: Address) => unknown;

/** A PublicClient stand-in whose contract reads are answered by `handlers`, keyed by function name. */
function stubClient(handlers: Record<string, Handler>, extra: Partial<PublicClient> = {}) {
  const reads: Read[] = [];
  const client = {
    async readContract({ address, functionName, args = [] }: Read) {
      reads.push({ address, functionName, args });
      const handler = handlers[functionName];
      if (!handler) throw new Error(`unexpected read ${functionName}`);
      return handler(args, address);
    },
    ...extra,
  };
  return { client: client as unknown as PublicClient, reads };
}

const offline = stubClient({}).client;

describe("morphoMarketId", () => {
  it("matches Morpho's keccak256(abi.encode(marketParams))", () => {
    // WETH market of Hyperithm USDC Apex on Monad (USDC loan, WETH collateral, LLTV 86%).
    const id = morphoMarketId({
      loanToken: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      collateralToken: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
      oracle: "0xF06b8511305Df760c12A3755081D95B039915396",
      irm: "0x09475a3D6eA8c314c592b1a3799bDE044E2F400F",
      lltv: 860000000000000000n,
    });
    expect(id).toBe("0x409f2824aee2d8391d4a5924935e13312e157055e262b923b60c9dcb47e6311d");
  });
});

describe("formatBps", () => {
  it("formats basis points as a percentage", () => {
    expect(formatBps(250)).toBe("2.50%");
    expect(formatBps(10_000, 0)).toBe("100%");
    expect(formatBps(1n)).toBe("0.01%");
    expect(formatBps(12345, 1)).toBe("123.5%");
    expect(formatBps(0)).toBe("0.00%");
  });

  it("formats token amounts with grouping and at most four decimals", () => {
    expect(formatUnitsShort(1234567890123n, 6)).toBe("1,234,567.8901");
    expect(formatUnitsShort(10n ** 18n, 18)).toBe("1");
    expect(formatUnitsShort(123456789n, 6, 2)).toBe("123.46");
  });
});

describe("parseDeployment", () => {
  it("accepts a complete Aave deployment", () => {
    const raw = {
      network: "usdt0-replay",
      chainId: 143,
      venue: "aave",
      market: addr(1),
      receipt: addr(2),
      underlying: addr(3),
      priceRouter: addr(4),
      selioVault: addr(5),
      aavePool: addr(6),
      debtToken: addr(7),
      payTokens: [],
    };
    const d = parseDeployment(raw);
    expect(d.market).toBe(addr(1));
    expect(d).toBe(raw);
  });

  it("rejects missing fields", () => {
    expect(() => parseDeployment({ ...AAVE, market: undefined })).toThrow(/market/);
    expect(() => parseDeployment({ ...AAVE, aavePool: undefined })).toThrow(/aave/);
    expect(() => parseDeployment({ ...MORPHO, adapter: undefined })).toThrow(/morpho fields missing/);
    expect(() => parseDeployment(null)).toThrow("deployment: not an object");
    expect(() => parseDeployment([])).toThrow("deployment: missing network");
  });
});

describe("ABI", () => {
  it("encodes a buy call with the venue data argument", () => {
    const data = encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "buyAndRepay", args: [1n, 10n, 0, 10n, "0x"] });
    expect(data.startsWith("0x")).toBe(true);
  });

  it("gives every market function the SDK calls the same selector on both venues", () => {
    const names = [
      "FEE_BPS",
      "activeBidIdsPage",
      "bidCapacity",
      "bidCapacityAt",
      "bids",
      "buyAndRepay",
      "buyAndRepayWithCollateral",
      "cancelBid",
      "capacity",
      "discountOf",
      "feeRecipient",
      "isOpen",
      "matchBid",
      "nextSessionId",
      "openSession",
      "placeBid",
      "quote",
      "redeemReceipt",
      "remainingAssets",
      "sellNow",
      "sessions",
      "withdrawUnsold",
    ];
    for (const name of names) {
      const aave = aaveExitMarketAbi.find((e) => e.type === "function" && e.name === name);
      const morpho = morphoVaultExitMarketAbi.find((e) => e.type === "function" && e.name === name);
      expect(aave, name).toBeDefined();
      expect(morpho, name).toBeDefined();
      expect(toFunctionSelector(aave as never), name).toBe(toFunctionSelector(morpho as never));
    }
  });
});

describe("protocol fee", () => {
  it("reads FEE_BPS once and computes each fee locally, rounded down", async () => {
    const { client, reads } = stubClient({ FEE_BPS: () => 20 });
    const selio = new SelioClient(AAVE, client);
    expect(await selio.feeBps()).toBe(20);
    expect(await selio.feeOf(499n)).toBe(0n);
    expect(await selio.feeOf(500n)).toBe(1n);
    expect(await selio.feeOf(1_000_000n)).toBe(2_000n);
    expect(await selio.feeOf(49_500_000_000n)).toBe(99_000_000n);
    expect(reads.filter((r) => r.functionName === "FEE_BPS")).toHaveLength(1);
  });

  it("quotes what the seller receives after the fee", async () => {
    const { client, reads } = stubClient({ FEE_BPS: () => 20, quote: () => 19_400_000_000n });
    const selio = new SelioClient(AAVE, client);
    const q = await selio.sellerQuote(20_000_000_000n, 300, addr(11));
    expect(q).toEqual({ payment: 19_400_000_000n, fee: 38_800_000n, sellerNet: 19_361_200_000n });
    expect(reads.find((r) => r.functionName === "quote")?.args).toEqual([20_000_000_000n, 300, addr(11)]);
  });

  it("plans a sale best price first, with the fee taken per fill", async () => {
    const book: Record<string, { minD: number; payIdx: number; capacity: bigint }> = {
      "4": { minD: 100, payIdx: 0, capacity: 30n },
      "2": { minD: 150, payIdx: 1, capacity: 50n },
      "5": { minD: 160, payIdx: 0, capacity: 0n },
      "9": { minD: 200, payIdx: 0, capacity: 50n },
      "1": { minD: 900, payIdx: 0, capacity: 50n },
    };
    const quotes: Record<string, bigint> = { "30/100": 1_234_567n, "40/200": 499n };
    const { client, reads } = stubClient({
      activeBidIdsPage: ([offset]) => ((offset as bigint) === 0n ? [9n, 1n, 4n, 2n, 5n] : []),
      bids: ([id]) => {
        const b = book[String(id)]!;
        return [addr(99), b.minD, b.payIdx, 1_000n, 1_000_000_000n];
      },
      bidCapacity: ([id]) => book[String(id)]!.capacity,
      FEE_BPS: () => 20,
      quote: ([assets, d]) => quotes[`${assets}/${d}`],
    });
    const selio = new SelioClient(AAVE, client);
    const plan = await selio.planSellNow(70n, 500, 1);
    const token = addr(10);
    expect(plan.bidIds).toEqual([4n, 9n]);
    expect(plan.fills).toEqual([
      { bidId: 4n, assets: 30n, pay: 1_234_567n, fee: 2_469n, sellerNet: 1_232_098n, payToken: token, discountBps: 100 },
      { bidId: 9n, assets: 40n, pay: 499n, fee: 0n, sellerNet: 499n, payToken: token, discountBps: 200 },
    ]);
    expect(plan.filledAssets).toBe(70n);
    expect(plan.proceeds).toEqual({ [token]: 1_235_066n });
    expect(plan.fees).toEqual({ [token]: 2_469n });
    expect(plan.sellerNet).toEqual({ [token]: 1_232_597n });
    expect(plan.averageDiscountBps).toBe(157);
    expect(reads.filter((r) => r.functionName === "quote").map((r) => r.args)).toEqual([
      [30n, 100, token],
      [40n, 200, token],
    ]);
    expect(reads.filter((r) => r.functionName === "FEE_BPS")).toHaveLength(1);
  });

  it("reads every page of the active-bid view before sorting", async () => {
    const ids = Array.from({ length: 205 }, (_, i) => BigInt(205 - i));
    const { client, reads } = stubClient({
      activeBidIdsPage: ([offset, limit]) => ids.slice(Number(offset), Number(offset as bigint) + Number(limit)),
      bids: ([id]) => [addr(99), Number((id as bigint) % 7n) * 100, 0, 1n, 1n],
      bidCapacity: () => 1n,
    });
    const bids = await new SelioClient(AAVE, client).bids();
    expect(reads.filter((r) => r.functionName === "activeBidIdsPage")).toHaveLength(3);
    expect(bids).toHaveLength(205);
    for (let i = 1; i < bids.length; i++) {
      const [a, b] = [bids[i - 1]!, bids[i]!];
      expect(a.minDiscountBps < b.minDiscountBps || (a.minDiscountBps === b.minDiscountBps && a.id < b.id)).toBe(true);
    }
  });
});

describe("vault base yield", () => {
  const vaultReads = (overrides: Record<string, Handler> = {}) => ({
    totalAssets: () => 100_000_000_000n,
    idleAssets: () => 20_000_000_000n,
    heldAssets: () => 0n,
    totalSupply: () => 100_000_000_000_000n,
    decimals: (_: readonly unknown[], address: Address) => (address === AAVE.selioVault ? 9 : 6),
    bidOf: () => 3n,
    strategy: () => ({ market: addr(1), receipt: addr(2), minDiscountBps: 300, maxShareBps: 2_000, payIdx: 2 }),
    yieldSource: () => addr(30),
    symbol: () => "waMonUSDC",
    sourceShares: () => 75_000_000_000n,
    sourceAssets: () => 80_000_000_000n,
    sourceUtilizationBps: () => 9_500n,
    balanceOf: () => 1_000_000_000_000n,
    previewRedeem: () => [200_000_000n, [5_000_000n], 740_000_000n],
    ...overrides,
  });

  it("reports the yield source and the source shares a redemption pays in kind", async () => {
    const { client, reads } = stubClient(vaultReads());
    const v = await new SelioClient(AAVE, client).vaultState(addr(40));
    expect(v).toMatchObject({
      totalAssets: 100_000_000_000n,
      idleAssets: 20_000_000_000n,
      decimals: 9,
      bidId: 3n,
      minDiscountBps: 300,
      maxShareBps: 2_000,
      shares: 1_000_000_000_000n,
      redeemNow: 200_000_000n,
      redeemInKind: 5_000_000n,
      yieldSource: addr(30),
      sourceSymbol: "waMonUSDC",
      sourceShares: 75_000_000_000n,
      sourceAssets: 80_000_000_000n,
      sourceUtilizationBps: 9_500,
      redeemSourceInKind: 740_000_000n,
    });
    expect(reads.find((r) => r.functionName === "balanceOf")).toMatchObject({ address: AAVE.selioVault, args: [addr(40)] });
    expect(reads.find((r) => r.functionName === "previewRedeem")?.args).toEqual([1_000_000_000_000n]);
  });

  it("skips the source reads and the preview without a source or an account", async () => {
    const { client, reads } = stubClient(vaultReads({ yieldSource: () => zeroAddress }));
    const v = await new SelioClient(AAVE, client).vaultState();
    expect(v).toMatchObject({
      yieldSource: zeroAddress,
      sourceSymbol: "",
      sourceShares: 0n,
      sourceAssets: 0n,
      sourceUtilizationBps: 0,
      shares: 0n,
      redeemNow: 0n,
      redeemInKind: 0n,
      redeemSourceInKind: 0n,
    });
    const names = reads.map((r) => r.functionName);
    for (const skipped of ["sourceShares", "sourceAssets", "sourceUtilizationBps", "symbol", "balanceOf", "previewRedeem"]) {
      expect(names).not.toContain(skipped);
    }
  });
});

describe("transaction builders", () => {
  const selio = new SelioClient(AAVE, offline);
  const plan: SellPlan = {
    bidIds: [4n, 9n],
    fills: [],
    filledAssets: 70n,
    proceeds: {},
    fees: {},
    sellerNet: {},
    averageDiscountBps: 157,
  };
  const session = { startBps: 100, stepBps: 50, stepInterval: 3600, capBps: 2000, duration: 1209600, payMask: 0b1111 };

  it("encodes each call with its selector, target, size and description", () => {
    const cases: [ReturnType<SelioClient["approve"]>, Address, string, number, string][] = [
      [selio.approve(addr(10), addr(1)), addr(10), "0x095ea7b3", 68, `Approve ${addr(1)} to spend token ${addr(10)}`],
      [selio.openSession(10n, session), addr(1), "0x74fb7594", 228, "Escrow receipts and open a Dutch-auction exit session"],
      [selio.withdrawUnsold(3n), addr(1), "0x7470d4dc", 68, "Take back unsold receipts from a session"],
      [
        selio.buyAndRepay(1n, 10n, 0, 10n, "0x"),
        addr(1),
        "0xc4e9c356",
        196,
        "Buy receipts at the current discount; the market repays your debt in the same transaction",
      ],
      [
        selio.buyAndRepayWithCollateral(1n, 10n, 0, 10n, "0x"),
        addr(1),
        "0xe049c5c1",
        196,
        "Flash mode: repay debt first, then pay the seller with the collateral that frees up",
      ],
      [selio.placeBid(500, 0, 10n, 10n), addr(1), "0x04978e30", 132, "Escrow funds and place a limit bid for receipts"],
      [selio.cancelBid(7n), addr(1), "0x9703ef35", 36, "Cancel a limit bid and get unused escrow back immediately"],
      [selio.sellNow(plan, 500, 1, 70n), addr(1), "0x29cc1ca0", 260, "Sell receipts now into escrowed bids, best price first"],
      [selio.matchBid(1n, 2n), addr(1), "0x5c85862b", 100, "Fill a limit bid from a session whose discount has reached it"],
      [selio.redeemReceipt(10n, addr(40)), addr(1), "0xa7e7d3d0", 68, "Redeem receipts for the underlying once the pool is liquid"],
      [selio.vaultDeposit(10n, addr(40), 9n), addr(5), "0xbc157ac1", 100, "Deposit into the Selio Vault"],
      [selio.vaultRedeem(10n, addr(40), addr(40)), addr(5), "0xe0b7d7f1", 164, "Redeem vault shares: idle capital now, held receipts in kind"],
      [selio.vaultRecover(), addr(5), "0x6e1ed775", 68, "Redeem receipts held by the vault now that the pool is liquid"],
      [
        selio.routeRepayWithFrozenCollateral(100n, plan, 500, 1, 50n, 49n),
        addr(8),
        "0x91920842",
        324,
        "Repay debt by selling frozen collateral into bids (no withdrawal needed)",
      ],
      [
        selio.routeSwapFrozenCollateral(100n, plan, 500, 1, 49n),
        addr(8),
        "0x057dac76",
        292,
        "Swap frozen collateral for new collateral by selling it into bids",
      ],
    ];
    for (const [tx, to, selector, bytes, description] of cases) {
      expect(tx.to, description).toBe(to);
      expect(tx.data.slice(0, 10), description).toBe(selector);
      expect(size(tx.data), description).toBe(bytes);
      expect(tx.value, description).toBe(0n);
      expect(tx.description).toBe(description);
    }
  });

  it("defaults sizes and allowances to the full range", () => {
    expect(selio.withdrawUnsold(3n)).toEqual({
      to: addr(1),
      data: `0x7470d4dc${"0".repeat(63)}3${"f".repeat(64)}`,
      value: 0n,
      description: "Take back unsold receipts from a session",
    });
    expect(selio.approve(addr(10), addr(1)).data.endsWith("f".repeat(64))).toBe(true);
    expect(decodeFunctionData({ abi: aaveExitMarketAbi, data: selio.matchBid(1n, 2n).data }).args).toEqual([1n, 2n, maxUint256]);
    expect(decodeFunctionData({ abi: selioVaultAbi, data: selio.vaultRecover().data }).args).toEqual([0n, maxUint256]);
  });

  it("sends the plan's filled amount and bid order to sellNow", () => {
    const { args } = decodeFunctionData({ abi: aaveExitMarketAbi, data: selio.sellNow(plan, 500, 1, 69n).data });
    expect(args).toEqual([70n, [4n, 9n], 500, 1, 69n]);
  });

  it("maps the receipts to skip onto the vault's strategy indexes", () => {
    const { args } = decodeFunctionData({ abi: selioVaultAbi, data: selio.vaultRedeem(10n, addr(40), addr(41), [addr(2)]).data });
    expect(args).toEqual([10n, addr(40), addr(41), [0n]]);
    expect(() => selio.vaultRedeem(10n, addr(40), addr(41), [addr(3)])).toThrow(/not a receipt the Selio Vault holds/);
  });

  it("refuses the frozen-collateral route where none is deployed", () => {
    const noRoute = new SelioClient({ ...AAVE, collateralRoute: undefined }, offline);
    expect(() => noRoute.routeRepayWithFrozenCollateral(1n, plan, 500, 1, 1n, 1n)).toThrow(
      "the frozen-collateral route exists on Aave networks only",
    );
    expect(() => new SelioClient(MORPHO, offline).routeSwapFrozenCollateral(1n, plan, 500, 1, 1n)).toThrow(
      "the frozen-collateral route exists on Aave networks only",
    );
  });
});

describe("Morpho flash mode", () => {
  const params = { loanToken: addr(3), collateralToken: addr(12), oracle: addr(23), irm: zeroAddress, lltv: 860000000000000000n };
  const marketId = morphoMarketId(params);
  const borrower = (borrowShares: bigint) =>
    stubClient({
      marketIdsLength: () => 1n,
      marketIds: () => marketId,
      idToMarketParams: () => [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
      position: () => [0n, borrowShares, 10n ** 18n],
      market: () => [2_000_000_000n, 2_000_000_000_000_000n, 1_000_000_000n, 1_000_000_000_000_000n, 1n, 0n],
      price: () => 10n ** 36n,
    }).client;

  it("encodes venue data with the borrower's market, the force flag and the authorization", async () => {
    const selio = new SelioClient(MORPHO, borrower(1_000_000_000_000_000n));
    const plain = await selio.venueData(addr(40));
    expect(size(plain)).toBe(256);
    const auth = toHex(new Uint8Array(512).fill(1));
    const full = await selio.venueData(addr(40), { force: true, auth });
    expect(size(full)).toBe(768);
    const [market, force, bytes] = decodeAbiParameters(
      parseAbiParameters("(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv), bool, bytes"),
      full,
    );
    expect(market).toEqual(params);
    expect(force).toBe(true);
    expect(bytes).toBe(auth);
    expect(await new SelioClient(AAVE, offline).venueData(addr(40))).toBe("0x");
  });

  it("refuses venue data for an account without debt in the vault's markets", async () => {
    await expect(new SelioClient(MORPHO, borrower(0n)).venueData(addr(40))).rejects.toThrow(/no USDC debt/i);
  });

  it("signs a grant and a revoke that recover to the buyer under Morpho's domain", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const wallet = createWalletClient({ account, transport: http("http://127.0.0.1:9") });
    const { client, reads } = stubClient(
      { nonce: () => 5n },
      { getChainId: async () => 143, getBlock: (async () => ({ timestamp: 2_000_000_000n })) as never },
    );
    const blob = await new SelioClient(MORPHO, client).signMorphoAuthorization(wallet, account.address);
    expect(size(blob)).toBe(512);
    expect(reads.map((r) => r.functionName)).toEqual(["nonce"]);

    const auth = "(address authorizer, address authorized, bool isAuthorized, uint256 nonce, uint256 deadline)";
    const sig = "(uint8 v, bytes32 r, bytes32 s)";
    const [grant, grantSig, revoke, revokeSig] = decodeAbiParameters(
      parseAbiParameters(`${auth}, ${sig}, ${auth}, ${sig}`),
      blob,
    );
    expect(grant).toEqual({ authorizer: account.address, authorized: MORPHO.market, isAuthorized: true, nonce: 5n, deadline: 2_000_003_600n });
    expect(revoke).toEqual({ ...grant, isAuthorized: false, nonce: 6n });

    // Morpho's on-chain digest: keccak256("\x19\x01" ‖ domainSeparator ‖ structHash).
    const domainTypeHash = keccak256(toHex("EIP712Domain(uint256 chainId,address verifyingContract)"));
    const authTypeHash = keccak256(toHex("Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"));
    expect(domainTypeHash).toBe("0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218");
    expect(authTypeHash).toBe("0x81d0284fb0e2cde18d0553b06189d6f7613c96a01bb5b5e7828eade6a0dcac91");
    const domainSeparator = keccak256(
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }, { type: "address" }], [domainTypeHash, 143n, MORPHO.morpho!]),
    );
    const digest = (a: typeof grant): Hex =>
      keccak256(
        concat([
          "0x1901",
          domainSeparator,
          keccak256(
            encodeAbiParameters(
              [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
              [authTypeHash, a.authorizer, a.authorized, a.isAuthorized, a.nonce, a.deadline],
            ),
          ),
        ]),
      );
    for (const [a, sig] of [[grant, grantSig], [revoke, revokeSig]] as const) {
      expect([27, 28]).toContain(sig.v);
      const signer = await recoverAddress({ hash: digest(a), signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) } });
      expect(signer).toBe(account.address);
    }
  });

  it("refuses to sign on Aave", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const wallet = createWalletClient({ account, transport: http("http://127.0.0.1:9") });
    await expect(new SelioClient(AAVE, offline).signMorphoAuthorization(wallet, account.address)).rejects.toThrow(
      "authorization is only needed on Morpho",
    );
  });
});
