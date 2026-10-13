import type { Address, Hex, PublicClient } from "viem";
import { aaveExitMarketAbi, kuruSellRouterAbi, type SelioClient } from "@selio/sdk";

const deployBlocks = new Map<string, Promise<bigint>>();

async function hasCode(pc: PublicClient, address: Address, blockNumber: bigint): Promise<boolean> {
  try {
    const code = await pc.getCode({ address, blockNumber });
    return !!code && code !== "0x";
  } catch {
    // Forks and pruned nodes cannot serve old state: count it as no code.
    return false;
  }
}

/** Interval search for the first block with code at `address`, 7 probes per round. */
async function searchDeployBlock(pc: PublicClient, address: Address): Promise<bigint> {
  let hi = await pc.getBlockNumber();
  let lo = 0n;
  while (hi - lo > 1n) {
    const span = (hi - lo) / 8n;
    const step = span > 0n ? span : 1n;
    const points: bigint[] = [];
    for (let i = 1n; i <= 7n; i++) {
      const p = lo + step * i;
      if (p < hi) points.push(p);
    }
    if (points.length === 0) break;
    const found = await Promise.all(points.map((p) => hasCode(pc, address, p)));
    const first = found.indexOf(true);
    if (first === -1) {
      lo = points[points.length - 1] ?? lo;
    } else {
      hi = points[first] ?? hi;
      if (first > 0) lo = points[first - 1] ?? lo;
    }
  }
  return (await hasCode(pc, address, lo)) ? lo : hi;
}

/** First block of the market, cached per RPC client; a failed search is retried next time. */
export function findDeployBlock(pc: PublicClient, address: Address): Promise<bigint> {
  const key = `${pc.uid}:${address}`;
  let pending = deployBlocks.get(key);
  if (!pending) {
    pending = searchDeployBlock(pc, address);
    deployBlocks.set(key, pending);
    pending.catch(() => deployBlocks.delete(key));
  }
  return pending;
}

/** Event reads start at the deployment's own block when the file records one (correct on Monad). */
function fromBlockOf(selio: SelioClient): Promise<bigint> {
  const recorded = selio.deployment.deployBlock;
  if (Number.isInteger(recorded) && recorded > 0) return Promise.resolve(BigInt(recorded));
  return findDeployBlock(selio.client, selio.deployment.market);
}

export interface SellerFill {
  sessionId: bigint;
  assets: bigint;
  paid: bigint;
  /** Protocol fee taken from `paid`; the seller received `paid − fee`. */
  fee: bigint;
  payToken: Address | null;
  discountBps: number;
  txHash: Hex | null;
  /** "kuru": the Kuru part of a sale routed through KuruSellRouter, which pays no Selio fee. */
  via: "borrower" | "bid" | "kuru";
}

export interface SellerHistory {
  /** Face value each of the seller's auctions opened with. */
  opened: Map<bigint, bigint>;
  /** Purchases first, then bid fills; a bid fill with sessionId 0 is a sell-now fill. */
  fills: SellerFill[];
}

/** The Kuru part of a routed sale: the face value sold on Kuru for what Kuru paid, in the underlying, with no Selio fee. */
export function kuruSaleFill(sale: { kuruAssets: bigint; kuruOut: bigint; txHash: Hex | null }, underlying: Address): SellerFill | null {
  if (sale.kuruAssets === 0n) return null;
  const discountBps =
    sale.kuruOut >= sale.kuruAssets ? 0 : Number(((sale.kuruAssets - sale.kuruOut) * 10_000n) / sale.kuruAssets);
  return {
    sessionId: 0n,
    assets: sale.kuruAssets,
    paid: sale.kuruOut,
    fee: 0n,
    payToken: underlying,
    discountBps,
    txHash: sale.txHash,
    via: "kuru",
  };
}

export interface SellNowRow {
  key: string;
  label: string;
  fills: SellerFill[];
}

/** Sell-now fills (session 0), one row per transaction; a routed sale's row covers its Selio bids and its Kuru part. */
export function sellNowRows(fills: readonly SellerFill[]): SellNowRow[] {
  const groups = new Map<string, SellerFill[]>();
  fills
    .filter((f) => f.sessionId === 0n)
    .forEach((f, n) => {
      const key = f.txHash ?? `fill-${n}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    });
  return [...groups].map(([key, group]) => {
    const kuru = group.some((f) => f.via === "kuru");
    const bids = group.some((f) => f.via !== "kuru");
    const label = kuru && bids ? "Sold now to bids and Kuru" : kuru ? "Sold now on Kuru" : "Sold now to bids";
    return { key, label, fills: group };
  });
}

export async function loadSellerHistory(selio: SelioClient, seller: Address): Promise<SellerHistory> {
  const fromBlock = await fromBlockOf(selio);
  const market = { address: selio.deployment.market, abi: aaveExitMarketAbi, fromBlock, strict: true } as const;
  const router = selio.deployment.kuruSellRouter;
  const [opened, ownFills, routedSales] = await Promise.all([
    selio.client.getContractEvents({ ...market, eventName: "SessionOpened", args: { seller } }),
    selio.client.getContractEvents({ ...market, eventName: "BidFilled", args: { seller } }),
    router
      ? selio.client.getContractEvents({
          address: router,
          abi: kuruSellRouterAbi,
          eventName: "KuruRoutedSale",
          args: { seller },
          fromBlock,
          strict: true,
        })
      : Promise.resolve([]),
  ]);
  // In a routed sale the router is the market's seller: its bid fills in the seller's routed transactions are theirs.
  const routedTxs = new Set(routedSales.map((log) => log.transactionHash));
  const routerFills =
    router && routedTxs.size > 0
      ? (await selio.client.getContractEvents({ ...market, eventName: "BidFilled", args: { seller: router } })).filter((log) =>
          routedTxs.has(log.transactionHash),
        )
      : [];
  const bidFills = [...ownFills, ...routerFills];
  const sessionIds = opened.map((log) => log.args.sessionId);
  const bidIds = [...new Set(bidFills.map((log) => log.args.bidId))];
  const [bought, placed] = await Promise.all([
    sessionIds.length
      ? selio.client.getContractEvents({ ...market, eventName: "Bought", args: { sessionId: sessionIds } })
      : Promise.resolve([]),
    bidIds.length
      ? selio.client.getContractEvents({ ...market, eventName: "BidPlaced", args: { bidId: bidIds } })
      : Promise.resolve([]),
  ]);
  const bidPayToken = new Map(placed.map((log) => [log.args.bidId, log.args.payToken]));
  const fills: SellerFill[] = [
    ...bought.map((log) => ({
      sessionId: log.args.sessionId,
      assets: log.args.assets,
      paid: log.args.paid,
      fee: log.args.fee,
      payToken: log.args.payToken,
      discountBps: Number(log.args.discountBps),
      txHash: log.transactionHash ?? null,
      via: "borrower" as const,
    })),
    ...bidFills.map((log) => ({
      sessionId: log.args.sessionId,
      assets: log.args.assets,
      paid: log.args.paid,
      fee: log.args.fee,
      payToken: bidPayToken.get(log.args.bidId) ?? null,
      discountBps: Number(log.args.discountBps),
      txHash: log.transactionHash ?? null,
      via: "bid" as const,
    })),
    ...routedSales.flatMap((log) => {
      const fill = kuruSaleFill(
        { kuruAssets: log.args.kuruAssets, kuruOut: log.args.kuruOut, txHash: log.transactionHash ?? null },
        selio.deployment.underlying,
      );
      return fill ? [fill] : [];
    }),
  ];
  return { opened: new Map(opened.map((log) => [log.args.sessionId, log.args.assets])), fills };
}

/** Original size (maxAssets) of each bid the bidder placed. */
export async function loadBidOrigins(selio: SelioClient, bidder: Address): Promise<Map<bigint, bigint>> {
  const fromBlock = await fromBlockOf(selio);
  const logs = await selio.client.getContractEvents({
    address: selio.deployment.market,
    abi: aaveExitMarketAbi,
    eventName: "BidPlaced",
    args: { bidder },
    fromBlock,
    strict: true,
  });
  return new Map(logs.map((log) => [log.args.bidId, log.args.maxAssets]));
}

export interface FillSummary {
  assets: bigint;
  /** What the seller received per pay token, net of the protocol fee. */
  received: { token: Address; amount: bigint }[];
  fees: { token: Address; amount: bigint }[];
  avgDiscountBps: number | null;
}

export function summarizeFills(fills: readonly SellerFill[]): FillSummary {
  let assets = 0n;
  let weighted = 0n;
  const received = new Map<Address, bigint>();
  const fees = new Map<Address, bigint>();
  for (const f of fills) {
    assets += f.assets;
    weighted += f.assets * BigInt(f.discountBps);
    if (f.payToken) {
      received.set(f.payToken, (received.get(f.payToken) ?? 0n) + f.paid - f.fee);
      fees.set(f.payToken, (fees.get(f.payToken) ?? 0n) + f.fee);
    }
  }
  return {
    assets,
    received: [...received].map(([token, amount]) => ({ token, amount })),
    fees: [...fees].map(([token, amount]) => ({ token, amount })),
    avgDiscountBps: assets === 0n ? null : Number(weighted / assets),
  };
}
