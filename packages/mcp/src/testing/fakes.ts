import { createPublicClient, custom, getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import { vi, type Mock } from "vitest";
import { NETWORKS, SelioClient, type Deployment, type NetworkKey, type SessionView } from "@selio/sdk";
import type { ChainReads, NetworkHandle, SelioChain } from "../chain.js";
import { NETWORK_KEYS } from "../config.js";
import { ToolError } from "../errors.js";

export const a = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

export const ADDR = {
  market: a(0x1001),
  aMonUSDT0: a(0x1002),
  USDT0: a(0x1003),
  priceRouter: a(0x1004),
  aaveVault: a(0x1005),
  AUSD: a(0x1006),
  USDC: a(0x1007),
  WETH: a(0x1008),
  aMonUSDC: a(0x1009),
  aMonWETH: a(0x100a),
  aavePool: a(0x100b),
  debtToken: a(0x100c),
  route: a(0x100d),
  aMonAUSD: a(0x100e),
  morphoMarket: a(0x2001),
  hyperUSDCa: a(0x2002),
  morphoUSDC: a(0x2003),
  morphoWETH: a(0x2004),
  morpho: a(0x2005),
  adapter: a(0x2006),
  morphoVault: a(0x2007),
  oracle: a(0x2008),
  irm: a(0x2009),
  waMonUSDC: a(0x200a),
  user: a(0xbeef),
  seller: a(0x5e11),
  bidder: a(0xb1d),
} as const;

export const AAVE_DEPLOYMENT: Deployment = {
  network: "usdt0-replay",
  chainId: 143,
  deployBlock: 1,
  venue: "aave",
  market: ADDR.market,
  receipt: ADDR.aMonUSDT0,
  underlying: ADDR.USDT0,
  priceRouter: ADDR.priceRouter,
  selioVault: ADDR.aaveVault,
  payTokens: [ADDR.AUSD, ADDR.USDC, ADDR.USDT0, ADDR.WETH],
  payATokens: [ADDR.aMonAUSD, ADDR.aMonUSDC, zeroAddress, ADDR.aMonWETH],
  aavePool: ADDR.aavePool,
  debtToken: ADDR.debtToken,
  collateralRoute: ADDR.route,
};

export const MORPHO_DEPLOYMENT: Deployment = {
  network: "vault-freeze",
  chainId: 143,
  deployBlock: 1,
  venue: "morpho",
  market: ADDR.morphoMarket,
  receipt: ADDR.hyperUSDCa,
  underlying: ADDR.morphoUSDC,
  priceRouter: ADDR.priceRouter,
  selioVault: ADDR.morphoVault,
  payTokens: [ADDR.morphoUSDC, ADDR.morphoWETH],
  morpho: ADDR.morpho,
  earnVault: ADDR.hyperUSDCa,
  adapter: ADDR.adapter,
  collateral: ADDR.morphoWETH,
};

export const TOKENS: Record<Address, { symbol: string; decimals: number }> = {
  [ADDR.aMonUSDT0]: { symbol: "aMonUSDT0", decimals: 6 },
  [ADDR.USDT0]: { symbol: "USDT0", decimals: 6 },
  [ADDR.AUSD]: { symbol: "AUSD", decimals: 6 },
  [ADDR.USDC]: { symbol: "USDC", decimals: 6 },
  [ADDR.WETH]: { symbol: "WETH", decimals: 18 },
  [ADDR.aMonAUSD]: { symbol: "aMonAUSD", decimals: 6 },
  [ADDR.aMonUSDC]: { symbol: "aMonUSDC", decimals: 6 },
  [ADDR.aMonWETH]: { symbol: "aMonWETH", decimals: 18 },
  [ADDR.aaveVault]: { symbol: "slUSDT0", decimals: 9 },
  [ADDR.hyperUSDCa]: { symbol: "hyperUSDCa", decimals: 18 },
  [ADDR.morphoUSDC]: { symbol: "USDC", decimals: 6 },
  [ADDR.morphoWETH]: { symbol: "WETH", decimals: 18 },
  [ADDR.morphoVault]: { symbol: "slUSDC", decimals: 9 },
  [ADDR.waMonUSDC]: { symbol: "waMonUSDC", decimals: 6 },
};

/** A PublicClient that fails every request, so tests cannot reach a network. */
export const offlineClient: PublicClient = createPublicClient({
  transport: custom({
    request() {
      throw new Error("network access is disabled in tests");
    },
  }),
});

export interface FakeNetwork {
  handle: NetworkHandle;
  sdk: SelioClient;
  reads: { [K in keyof ChainReads]: Mock<ChainReads[K]> };
}

/** A real SelioClient (so builders encode real calldata) whose reads are stubbed. */
export function fakeNetwork(deployment: Deployment): FakeNetwork {
  const sdk = new SelioClient(deployment, offlineClient);
  vi.spyOn(sdk, "token").mockImplementation(async (address: Address) => {
    const entry = Object.entries(TOKENS).find(([key]) => key.toLowerCase() === address.toLowerCase());
    if (!entry) throw new Error(`unknown token ${address}`);
    return { address, ...entry[1] };
  });
  vi.spyOn(sdk, "allowance").mockResolvedValue(0n);
  vi.spyOn(sdk, "feeBps").mockResolvedValue(20);
  const reads = {
    vaultAsset: vi.fn<ChainReads["vaultAsset"]>(async () => deployment.underlying),
    vaultPreviewRedeem: vi.fn<ChainReads["vaultPreviewRedeem"]>(async () => ({
      assets: 0n,
      receipts: [0n],
      sourceSharesInKind: 0n,
    })),
    vaultBaseYield: vi.fn<ChainReads["vaultBaseYield"]>(async () => null),
    morphoNonce: vi.fn<ChainReads["morphoNonce"]>(async () => 0n),
    morphoLiquidity: vi.fn<ChainReads["morphoLiquidity"]>(async () => ({ adapter: zeroAddress, data: "0x" })),
    latestTimestamp: vi.fn<ChainReads["latestTimestamp"]>(async () => 1_700_000_000n),
    blockNumber: vi.fn<ChainReads["blockNumber"]>(async () => 1_000_000n),
    call: vi.fn<ChainReads["call"]>(async () => ({ ok: true, returnData: "0x" })),
  };
  return { handle: { info: NETWORKS[deployment.network], deployment, sdk, reads }, sdk, reads };
}

export function fakeChain(handles: Partial<Record<NetworkKey, NetworkHandle>>): SelioChain {
  return {
    list: () => NETWORK_KEYS.map((key) => ({ info: NETWORKS[key], deployment: handles[key]?.deployment ?? null })),
    get: (key) => {
      const handle = handles[key];
      if (!handle) throw new ToolError(`No Selio deployment found for ${key}. Use list_networks to see deployed networks.`);
      return handle;
    },
  };
}

export function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 1n,
    seller: ADDR.seller,
    startedAt: 1_700_000_000,
    endsAt: 1_700_086_400,
    startBps: 100,
    stepBps: 50,
    capBps: 1_000,
    stepInterval: 3600,
    payMask: 0b1111,
    units: 10_000_000n,
    discountBps: 200,
    remainingAssets: 10_000_000n,
    open: true,
    acceptedPayTokens: [ADDR.AUSD, ADDR.USDC, ADDR.USDT0, ADDR.WETH],
    ...overrides,
  };
}
