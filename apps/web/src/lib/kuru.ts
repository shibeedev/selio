import { formatUnits, isAddressEqual, zeroAddress, type Address } from "viem";
import {
  kuruDebit,
  kuruMarginAccountAbi,
  kuruOrderBookAbi,
  kuruPriceForDiscount,
  kuruSizeForFace,
  type KuruMarketInfo,
  type RoutedSellPlan,
  type SelioClient,
} from "@selio/sdk";
import { formatToken } from "./format";

/** The deployment has a Kuru market of its receipt (Monad Testnet and USDT0 replay). */
export function hasKuru(selio: SelioClient): boolean {
  return !!(selio.deployment.kuruMarket && selio.deployment.kuruSellRouter && selio.deployment.kuruMarginAccount);
}

export const ROUTE_LABEL: Record<RoutedSellPlan["route"], string> = {
  selio: "Selio bids",
  "selio+kuru": "Selio bids and Kuru order book",
  kuru: "Kuru order book",
};

/** The fee line of a routed sale: Selio's fee applies to the Selio part only, Kuru charges its own taker fee. */
export function routedFeeLabel(feeBps: number, takerFeeBps: number): string {
  return `Selio fee ${trimPercent(feeBps)} on the Selio part; Kuru's own fee on the Kuru part (${trimPercent(takerFeeBps)})`;
}

function trimPercent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/** A Kuru price (pricePrecision units) as quote per whole base unit, e.g. "0.972 USDT0". */
export function kuruPriceText(price: number, m: KuruMarketInfo): string {
  const digits = Math.max(0, Math.round(Math.log10(m.pricePrecision)));
  return `${formatUnits(BigInt(price), digits)} ${m.quote.symbol}`;
}

export interface KuruBidPlan {
  price: number;
  size: bigint;
  /** Quote the order needs in the margin account (Kuru's debit). */
  debit: bigint;
  error: string | null;
}

/**
 * A limit bid on Kuru for up to `faceAssets` of face value at a discount of at least `discountBps`: the highest tick
 * price that keeps the discount, the largest size whose face fits (at most maxSize), and the quote Kuru debits for it.
 * A size below the market's minimum cannot be placed.
 */
export function kuruBidPlan(faceAssets: bigint, discountBps: number, face: bigint, m: KuruMarketInfo): KuruBidPlan {
  const price = kuruPriceForDiscount(discountBps, face, m);
  const size = kuruSizeForFace(faceAssets, face, m);
  if (price <= 0) return { price, size, debit: 0n, error: "That discount leaves no positive Kuru price" };
  if (size < m.minSize) {
    const minFace = (m.minSize * face) / m.sizePrecision;
    return { price, size, debit: 0n, error: `Kuru needs at least ${formatToken(minFace, m.quote)} of face value per order` };
  }
  return { price, size, debit: kuruDebit(price, size, m), error: null };
}

export type KuruOrderStatus = "active" | "filled";

export interface KuruOrder {
  id: bigint;
  price: number;
  /** Size still resting (sizePrecision units); 0 once filled. */
  remainingSize: bigint;
  status: KuruOrderStatus;
}

/** How many of the newest Kuru orders are read to find the user's own. */
export const KURU_ORDER_SCAN = 500;

/**
 * The account's buy orders among the newest order ids of the Kuru market. Kuru's events carry no indexed fields and the
 * public Monad testnet RPC serves logs 100 blocks at a time, so orders are read from `s_orders` instead: a cancelled
 * order is deleted, and a filled one keeps its record but its price point's queue head has moved past it.
 */
export async function loadKuruOrders(selio: SelioClient, owner: Address, scan = KURU_ORDER_SCAN): Promise<KuruOrder[]> {
  const book = selio.deployment.kuruMarket as Address;
  const pc = selio.client;
  const counter = BigInt(await pc.readContract({ address: book, abi: kuruOrderBookAbi, functionName: "s_orderIdCounter" }));
  const ids: bigint[] = [];
  for (let id = counter; id > 0n && counter - id < BigInt(scan); id--) ids.push(id);
  const records = await Promise.all(
    ids.map((id) => pc.readContract({ address: book, abi: kuruOrderBookAbi, functionName: "s_orders", args: [Number(id)] })),
  );
  const mine = ids.flatMap((id, i) => {
    const [ownerOf, size, , , , price, , isBuy] = records[i] ?? [];
    return ownerOf && !isAddressEqual(ownerOf, zeroAddress) && isAddressEqual(ownerOf, owner) && isBuy && price
      ? [{ id, price: Number(price), size: BigInt(size ?? 0n) }]
      : [];
  });
  const heads = await Promise.all(
    mine.map((o) => pc.readContract({ address: book, abi: kuruOrderBookAbi, functionName: "s_buyPricePoints", args: [BigInt(o.price)] })),
  );
  return mine.map((o, i) => {
    const head = BigInt(heads[i]?.[0] ?? 0);
    const filled = head === 0n || head > o.id;
    return { id: o.id, price: o.price, remainingSize: filled ? 0n : o.size, status: filled ? "filled" : "active" };
  });
}

/** The account's Kuru margin balances of the market's quote and base. */
export async function loadKuruBalances(selio: SelioClient, m: KuruMarketInfo, owner: Address): Promise<{ quote: bigint; base: bigint }> {
  const margin = selio.deployment.kuruMarginAccount as Address;
  const read = (token: Address) =>
    selio.client.readContract({ address: margin, abi: kuruMarginAccountAbi, functionName: "getBalance", args: [owner, token] });
  const [quote, base] = await Promise.all([read(m.quote.address), read(m.base.address)]);
  return { quote, base };
}
