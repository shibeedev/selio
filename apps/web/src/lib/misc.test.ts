import { encodeAbiParameters, type Address } from "viem";
import { describe, expect, it } from "vitest";
import type { MorphoMarketParams } from "@selio/sdk";
import { chartGeometry } from "./chart";
import { checkDeployment, loadDeployment } from "./deployment";
import { DEV_API_URL, PROD_API_URL, resolveApiUrl, resolveRpcUrl, rpcEnvName } from "./env";
import { summarizeFills, type SellerFill } from "./history";
import { bidLevels, bidOwner } from "./orderbook";
import { routeFromHash } from "./router";
import { withGasBuffer } from "./tx";
import { isLiquidityMarket } from "./venue";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

const morphoDeployment = {
  network: "monad-testnet",
  chainId: 10143,
  deployBlock: 1,
  venue: "morpho",
  market: a(1),
  receipt: a(2),
  underlying: a(3),
  priceRouter: a(4),
  selioVault: a(5),
  payTokens: [a(3), a(6)],
  morpho: a(7),
  earnVault: a(2),
  adapter: a(8),
};

describe("environment", () => {
  it("names the RPC override of each network", () => {
    expect(rpcEnvName("monad-testnet")).toBe("VITE_RPC_MONAD_TESTNET");
    expect(rpcEnvName("vault-freeze")).toBe("VITE_RPC_VAULT_FREEZE");
  });

  it("prefers a non-blank override over the SDK default", () => {
    expect(resolveRpcUrl("usdt0-replay", { VITE_RPC_USDT0_REPLAY: " http://127.0.0.1:9000 " })).toBe("http://127.0.0.1:9000");
    expect(resolveRpcUrl("usdt0-replay", { VITE_RPC_USDT0_REPLAY: " " })).toBe("http://127.0.0.1:8602");
  });

  it("defaults the backend per build and trims trailing slashes", () => {
    expect(resolveApiUrl({})).toBe(DEV_API_URL);
    expect(resolveApiUrl({ PROD: true })).toBe(PROD_API_URL);
    expect(resolveApiUrl({ VITE_API_URL: "https://api.example.com//" })).toBe("https://api.example.com");
  });
});

describe("deployment files", () => {
  it("accepts a file for the selected network", () => {
    expect(checkDeployment("monad-testnet", morphoDeployment).status).toBe("ready");
  });

  it("rejects a file for another network or chain", () => {
    expect(checkDeployment("vault-freeze", morphoDeployment)).toEqual({
      status: "invalid",
      error: 'the file is for "monad-testnet", not "vault-freeze"',
    });
    expect(checkDeployment("monad-testnet", { ...morphoDeployment, chainId: 143 })).toEqual({
      status: "invalid",
      error: "chain id 143 does not match 10143",
    });
  });

  it("reports the first missing field", () => {
    expect(checkDeployment("monad-testnet", { ...morphoDeployment, market: undefined })).toEqual({
      status: "invalid",
      error: "deployment: missing market",
    });
  });

  it("treats a 404 or an HTML page as not deployed", async () => {
    const notFound = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const html = (async () => new Response("<!doctype html><html></html>", { status: 200 })) as typeof fetch;
    const json = (async () => new Response(JSON.stringify(morphoDeployment), { status: 200 })) as typeof fetch;
    expect((await loadDeployment("monad-testnet", "/", notFound)).status).toBe("missing");
    expect((await loadDeployment("monad-testnet", "/", html)).status).toBe("missing");
    expect((await loadDeployment("monad-testnet", "/", json)).status).toBe("ready");
  });

  const serving = (files: Record<string, unknown>) => {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(url);
      return url in files
        ? new Response(JSON.stringify(files[url]), { status: 200 })
        : new Response(JSON.stringify({ code: "NOT_FOUND", message: "Not deployed" }), { status: 404 });
    }) as unknown as typeof fetch;
    return { urls, impl };
  };
  const API = "https://api.selio.site";
  const fork = {
    ...morphoDeployment,
    network: "usdt0-replay",
    chainId: 143,
    venue: "aave",
    aavePool: a(9),
    debtToken: a(10),
  };

  it("loads a fork's deployment from the backend", async () => {
    const api = serving({ [`${API}/deployments/usdt0-replay.json`]: fork });
    expect((await loadDeployment("usdt0-replay", "/", api.impl, API)).status).toBe("ready");
    expect(api.urls).toEqual([`${API}/deployments/usdt0-replay.json`]);
    const none = serving({});
    expect((await loadDeployment("vault-freeze", "/", none.impl, API)).status).toBe("missing");
    expect(none.urls).toEqual([`${API}/deployments/vault-freeze.json`]);
  });

  it("loads the live network's bundled file, and asks the backend only when the build has none", async () => {
    const bundled = serving({ "/deployments/monad-testnet.json": morphoDeployment });
    expect((await loadDeployment("monad-testnet", "/", bundled.impl, API)).status).toBe("ready");
    expect(bundled.urls).toEqual(["/deployments/monad-testnet.json"]);
    const fallback = serving({ [`${API}/deployments/monad-testnet.json`]: morphoDeployment });
    expect((await loadDeployment("monad-testnet", "/", fallback.impl, API)).status).toBe("ready");
    expect(fallback.urls).toEqual(["/deployments/monad-testnet.json", `${API}/deployments/monad-testnet.json`]);
  });
});

describe("order book", () => {
  it("groups capacity by discount and skips empty bids", () => {
    const levels = bidLevels([
      { minDiscountBps: 300, capacityAssets: 5n },
      { minDiscountBps: 200, capacityAssets: 10n },
      { minDiscountBps: 300, capacityAssets: 0n },
      { minDiscountBps: 200, capacityAssets: 5n },
    ]);
    expect(levels).toEqual([
      { discountBps: 200, size: 15n, cumulative: 15n },
      { discountBps: 300, size: 5n, cumulative: 20n },
    ]);
  });

  it("labels the vault's bid, the wallet's own and the others", () => {
    const vault = a(10);
    const me = a(11);
    expect(bidOwner(vault, vault, me)).toBe("vault");
    expect(bidOwner(me.toUpperCase().replace("0X", "0x") as Address, vault, me)).toBe("mine");
    expect(bidOwner(a(12), vault, me)).toBe("other");
    expect(bidOwner(me, vault, null)).toBe("other");
  });
});

describe("summarizeFills", () => {
  const fill = (assets: bigint, paid: bigint, fee: bigint, payToken: Address | null, discountBps: number): SellerFill => ({
    sessionId: 1n,
    assets,
    paid,
    fee,
    payToken,
    discountBps,
    txHash: null,
    via: "bid",
  });

  it("sums what the seller received net of the fee, per token, and the weighted discount", () => {
    const s = summarizeFills([
      fill(200n, 195_000n, 390n, a(1), 250),
      fill(100n, 97_300n, 194n, a(2), 270),
      fill(200n, 194_700n, 389n, a(1), 265),
    ]);
    expect(s.assets).toBe(500n);
    expect(s.avgDiscountBps).toBe(260);
    expect(s.received).toEqual([
      { token: a(1), amount: 195_000n - 390n + 194_700n - 389n },
      { token: a(2), amount: 97_300n - 194n },
    ]);
    expect(s.fees).toEqual([
      { token: a(1), amount: 779n },
      { token: a(2), amount: 194n },
    ]);
  });

  it("has no average without fills", () => {
    expect(summarizeFills([]).avgDiscountBps).toBeNull();
  });
});

describe("chart geometry", () => {
  const box = { width: 640, height: 210, left: 48, right: 14, top: 18, bottom: 30 };
  const points = [
    { t: 0, utilizationBps: 9_000 },
    { t: 60_000, utilizationBps: 10_000 },
  ];

  it("starts the axis at a multiple of 5% under the data and ends the line at the right edge", () => {
    const g = chartGeometry(points, box);
    expect(g.minBps).toBe(8_500);
    expect(g.polyline.split(" ")).toHaveLength(2);
    expect(g.last).toEqual({ x: 626, y: 18 });
    expect(g.yFor(10_000)).toBe(18);
  });

  it("keeps the alert threshold on the axis", () => {
    expect(chartGeometry(points, box, 7_000).minBps).toBeLessThanOrEqual(7_000);
  });
});

describe("router", () => {
  it("matches hash paths exactly and falls back to the Overview", () => {
    expect(routeFromHash("")).toBe("overview");
    expect(routeFromHash("#/sell")).toBe("sell");
    expect(routeFromHash("#/sell?x=1")).toBe("sell");
    expect(routeFromHash("#/frozen-collateral")).toBe("frozen");
    expect(routeFromHash("#/nope")).toBe("overview");
    expect(routeFromHash("#/sell/")).toBe("overview");
  });
});

describe("isLiquidityMarket", () => {
  const market: MorphoMarketParams = { loanToken: a(1), collateralToken: a(2), oracle: a(3), irm: a(4), lltv: 860_000_000_000_000_000n };
  const encode = (m: MorphoMarketParams) =>
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "loanToken", type: "address" },
            { name: "collateralToken", type: "address" },
            { name: "oracle", type: "address" },
            { name: "irm", type: "address" },
            { name: "lltv", type: "uint256" },
          ],
        },
      ],
      [m],
    );

  it("is true only for the vault's liquidity adapter and market", () => {
    expect(isLiquidityMarket(a(9), encode(market), a(9), market)).toBe(true);
    expect(isLiquidityMarket(a(9), encode({ ...market, lltv: 770_000_000_000_000_000n }), a(9), market)).toBe(false);
    expect(isLiquidityMarket(a(8), encode(market), a(9), market)).toBe(false);
    expect(isLiquidityMarket(a(9), "0x", a(9), market)).toBe(false);
  });
});

describe("withGasBuffer", () => {
  it("adds 30% to the estimate, rounded down", () => {
    expect(withGasBuffer(141_740n)).toBe(184_262n);
    expect(withGasBuffer(100_000n)).toBe(130_000n);
  });
});
