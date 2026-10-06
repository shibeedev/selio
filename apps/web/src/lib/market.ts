import type { Address } from "viem";
import { aaveExitMarketAbi, selioVaultAbi, type SelioClient, type TokenInfo, type Venue } from "@selio/sdk";
import { aaveFlashPayIndices } from "./paymask";

export class NotDeployedAtRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotDeployedAtRpcError";
  }
}

export interface VaultMeta {
  address: Address;
  asset: TokenInfo;
  name: string;
  symbol: string;
  decimals: number;
  minDiscountBps: number;
  maxShareBps: number;
  payIdx: number;
}

/** Static per-deployment facts, read once per client. */
export interface MarketMeta {
  venue: Venue;
  underlying: TokenInfo;
  receipt: TokenInfo;
  payTokens: TokenInfo[];
  vault: VaultMeta;
  maxDiscountBps: number;
  maxSessionDuration: number;
  aaveFlashPayIdx: number[];
  /** The market's FEE_BPS: the protocol fee on every fill, paid by the seller. */
  feeBps: number;
}

export async function loadMarketMeta(selio: SelioClient, rpcHint: string): Promise<MarketMeta> {
  const d = selio.deployment;
  const pc = selio.client;
  const code = await pc.getCode({ address: d.market });
  if (!code || code === "0x") throw new NotDeployedAtRpcError(`No Selio market at ${d.market} on this RPC. ${rpcHint}`);
  const vault = { address: d.selioVault, abi: selioVaultAbi } as const;
  const [underlying, receipt, payTokens, maxDiscountBps, maxSessionDuration, assetAddress, name, symbol, decimals, strategy, feeBps] =
    await Promise.all([
      selio.token(d.underlying),
      selio.token(d.receipt),
      selio.payTokens(),
      pc.readContract({ address: d.market, abi: aaveExitMarketAbi, functionName: "MAX_DISCOUNT_BPS" }),
      pc.readContract({ address: d.market, abi: aaveExitMarketAbi, functionName: "MAX_SESSION_DURATION" }),
      pc.readContract({ ...vault, functionName: "asset" }),
      pc.readContract({ ...vault, functionName: "name" }),
      pc.readContract({ ...vault, functionName: "symbol" }),
      pc.readContract({ ...vault, functionName: "decimals" }),
      pc.readContract({ ...vault, functionName: "strategy", args: [0n] }),
      selio.feeBps(),
    ]);
  const asset = await selio.token(assetAddress);
  return {
    venue: d.venue,
    underlying,
    receipt,
    payTokens,
    vault: {
      address: d.selioVault,
      asset,
      name,
      symbol,
      decimals: Number(decimals),
      minDiscountBps: Number(strategy.minDiscountBps),
      maxShareBps: Number(strategy.maxShareBps),
      payIdx: Number(strategy.payIdx),
    },
    maxDiscountBps: Number(maxDiscountBps),
    maxSessionDuration: Number(maxSessionDuration),
    aaveFlashPayIdx: d.venue === "aave" ? aaveFlashPayIndices(d) : [],
    feeBps,
  };
}

export function poolTitle(meta: MarketMeta): string {
  return meta.venue === "aave" ? meta.underlying.symbol : `${meta.underlying.symbol} Earn vault`;
}

export function poolSubtitle(meta: MarketMeta): string {
  return meta.venue === "aave" ? `Aave V3 · ${meta.receipt.symbol}` : `Morpho Vault · ${meta.receipt.symbol} shares`;
}

export function receiptNoun(meta: MarketMeta): string {
  return meta.venue === "aave" ? meta.receipt.symbol : `${meta.receipt.symbol} vault shares`;
}

/** Rules line of a Selio Vault without a yield source. */
export function baseYieldLine(asset: TokenInfo): string {
  if (/^wsteth$/i.test(asset.symbol)) return "wstETH staking yield: the vault holds wstETH and never lends it";
  return `none on this deployment: ${asset.symbol} waits idle in the vault, outside the pool it protects, so it is never frozen with it`;
}
