import type { Hex } from "viem";
import type { KuruLevel, KuruMarketInfo } from "./types.js";

// Pure Kuru conversions and the sell-now routing merge. `face` is the underlying value (wei) of one whole base unit:
// a price P (pricePrecision units) pays P × 10^quoteDecimals / pricePrecision quote wei per whole base unit, and a
// size S (sizePrecision units) is S × 10^baseDecimals / sizePrecision base wei. The quote is the underlying.

const BPS = 10_000n;
const WAD = 10n ** 18n;
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Bid levels of Kuru's `getL2Book` bytes: a block number, then (price, size) pairs best first up to a zero word. */
export function decodeL2Bids(data: Hex): { price: number; size: bigint }[] {
  const hex = data.slice(2);
  const words = Math.floor(hex.length / 64);
  const word = (i: number): bigint => BigInt(`0x${hex.slice(i * 64, i * 64 + 64)}`);
  const bids: { price: number; size: bigint }[] = [];
  for (let i = 1; i + 1 < words; i += 2) {
    const price = word(i);
    if (price === 0n) break;
    bids.push({ price: Number(price), size: word(i + 1) });
  }
  return bids;
}

/** Price at par: ⌊face × pricePrecision / 10^quoteDecimals⌋. */
export function kuruParPrice(face: bigint, m: KuruMarketInfo): number {
  return Number((face * BigInt(m.pricePrecision)) / pow10(m.quote.decimals));
}

/** Discount of `price` below face in basis points, rounded down; 0 for a price at or above par. */
export function kuruDiscountOfPrice(price: number, face: bigint, m: KuruMarketInfo): number {
  const faceScaled = face * BigInt(m.pricePrecision);
  const paid = BigInt(price) * pow10(m.quote.decimals);
  if (paid >= faceScaled) return 0;
  return Number(((faceScaled - paid) * BPS) / faceScaled);
}

/** Highest tick price that never pays more than `discountBps` below face. */
export function kuruPriceForDiscount(discountBps: number, face: bigint, m: KuruMarketInfo): number {
  const exact = (face * BigInt(m.pricePrecision) * (BPS - BigInt(discountBps))) / (pow10(m.quote.decimals) * BPS);
  return Number(exact - (exact % BigInt(m.tickSize)));
}

/** Quote Kuru debits from the margin account for a buy order: ⌈price × size / sizePrecision⌉ × 10^qd / pp. */
export function kuruDebit(price: number, size: bigint, m: KuruMarketInfo): bigint {
  const units = (BigInt(price) * size + m.sizePrecision - 1n) / m.sizePrecision;
  return (units * pow10(m.quote.decimals)) / BigInt(m.pricePrecision);
}

/** Base wei of `size` size units. */
export function kuruBaseAmount(size: bigint, m: KuruMarketInfo): bigint {
  return (size * pow10(m.base.decimals)) / m.sizePrecision;
}

/** Largest order size (at most maxSize) whose face value fits in `faceAssets`. */
export function kuruSizeForFace(faceAssets: bigint, face: bigint, m: KuruMarketInfo): bigint {
  const size = (faceAssets * m.sizePrecision) / face;
  return size < m.maxSize ? size : m.maxSize;
}

/** Book levels with their face value, discount and seller value per unit of face (net of Kuru's taker fee). */
export function kuruLevels(bids: { price: number; size: bigint }[], face: bigint, m: KuruMarketInfo): KuruLevel[] {
  return bids.map(({ price, size }) => {
    const baseAmount = kuruBaseAmount(size, m);
    return {
      price,
      size,
      baseAmount,
      faceAssets: (baseAmount * face) / pow10(m.base.decimals),
      discountBps: kuruDiscountOfPrice(price, face, m),
      netPerFaceWad:
        (BigInt(price) * pow10(m.quote.decimals) * (BPS - BigInt(m.takerFeeBps)) * WAD) /
        (BigInt(m.pricePrecision) * face * BPS),
    };
  });
}

/** Seller value per unit of face of a Selio fill at `discountBps`, net of Selio's fee (1e18 = face). */
export function selioNetPerFaceWad(discountBps: number, feeBps: number): bigint {
  return ((BPS - BigInt(discountBps)) * (BPS - BigInt(feeBps)) * WAD) / (BPS * BPS);
}

/** What the seller receives, in underlying terms, for `assets` of face sold into a Selio bid at `discountBps`. */
export function selioNetValue(assets: bigint, discountBps: number, feeBps: number): bigint {
  const pay = (assets * (BPS - BigInt(discountBps)) + BPS - 1n) / BPS;
  return pay - (pay * BigInt(feeBps)) / BPS;
}

/** A Selio bid the seller may sell into: its limit discount and the face value it can still buy. */
export interface SelioCandidate {
  discountBps: number;
  capacity: bigint;
}

/**
 * Splits `assets` of face value between Selio bids and Kuru levels, each unit to the candidate that pays the seller
 * more, and to Selio on ties. Both lists must be best first; the greedy walk is then optimal. Returns the face taken
 * from each Selio candidate and each Kuru level, in input order.
 */
export function mergeRoute(
  assets: bigint,
  selio: SelioCandidate[],
  kuru: KuruLevel[],
  feeBps: number,
): { selio: bigint[]; kuru: bigint[] } {
  const takes = { selio: selio.map(() => 0n), kuru: kuru.map(() => 0n) };
  let filled = 0n;
  let i = 0;
  let k = 0;
  while (filled < assets && (i < selio.length || k < kuru.length)) {
    const s = selio[i];
    const level = kuru[k];
    const useSelio = s !== undefined && (level === undefined || selioNetPerFaceWad(s.discountBps, feeBps) >= level.netPerFaceWad);
    const capacity = useSelio ? (s as SelioCandidate).capacity : (level as KuruLevel).faceAssets;
    const take = capacity < assets - filled ? capacity : assets - filled;
    if (useSelio) takes.selio[i++] = take;
    else takes.kuru[k++] = take;
    filled += take;
  }
  return takes;
}

/**
 * Net the seller would get for `faceAssets` from the Selio capacity the plan leaves unused (`unused[i]` per candidate),
 * best first: the value the Kuru leg displaces.
 */
export function displacedValue(faceAssets: bigint, selio: SelioCandidate[], unused: bigint[], feeBps: number): bigint {
  let left = faceAssets;
  let value = 0n;
  for (let i = 0; i < selio.length && left > 0n; i++) {
    const free = unused[i] ?? 0n;
    const take = free < left ? free : left;
    if (take === 0n) continue;
    value += selioNetValue(take, (selio[i] as SelioCandidate).discountBps, feeBps);
    left -= take;
  }
  return value;
}

/** Base sold on Kuru for `faceAssets` of face: ⌊faceAssets × 10^bd / face⌋ rounded down to the size grain. */
export function kuruBaseForFace(faceAssets: bigint, face: bigint, m: KuruMarketInfo): bigint {
  const one = pow10(m.base.decimals);
  const size = (((faceAssets * one) / face) * m.sizePrecision) / one;
  return kuruBaseAmount(size, m);
}

/** Least the Kuru leg may pay: the slippage bound, and strictly more than the Selio value it displaces. */
export function kuruMinOut(expectedOut: bigint, displaced: bigint, slippageBps: number): bigint {
  const bySlippage = (expectedOut * (BPS - BigInt(slippageBps))) / BPS;
  return bySlippage > displaced ? bySlippage : displaced + 1n;
}
