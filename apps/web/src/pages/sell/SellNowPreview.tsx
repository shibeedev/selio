import { useEffect } from "react";
import { isAddressEqual, type Address } from "viem";
import {
  kuruDiscountOfPrice,
  type BidView,
  type CapacityView,
  type KuruLevel,
  type KuruMarketInfo,
  type RoutedSellPlan,
  type SelioClient,
  type SellPlan,
} from "@selio/sdk";
import { Highlight, Notice, SummaryRow } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { feeLabel, formatPlanAmounts } from "../../lib/fees";
import { formatAmount, formatBps, formatToken, shortAddress } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { ROUTE_LABEL, routedFeeLabel } from "../../lib/kuru";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { allPayMask } from "../../lib/paymask";

/** What the sell-now preview planned: the Selio fills, and the routed plan when the network has a Kuru market. */
export interface PreviewPlan {
  selio: SellPlan;
  routed: RoutedSellPlan | null;
  kuru: { market: KuruMarketInfo; face: bigint } | null;
}

/** `amounts` plus `amount` of `token`, whatever the letter case of its key. */
function withAmount(amounts: Record<Address, bigint>, token: Address, amount: bigint): Record<Address, bigint> {
  const key = (Object.keys(amounts) as Address[]).find((a) => isAddressEqual(a, token)) ?? token;
  return { ...amounts, [key]: (amounts[key] ?? 0n) + amount };
}

/** Face-weighted discount of the Kuru leg's levels below the face value at planning time. */
function kuruAverageDiscount(kuru: NonNullable<RoutedSellPlan["kuru"]>, face: bigint, m: KuruMarketInfo): number {
  let weighted = 0n;
  let total = 0n;
  for (const l of kuru.levels) {
    weighted += l.faceAssets * BigInt(kuruDiscountOfPrice(l.price, face, m));
    total += l.faceAssets;
  }
  return total === 0n ? 0 : Number(weighted / total);
}

/**
 * Best-price-first fills of the amount, every payment asset, up to the market's maximum discount: into escrowed bids,
 * and on a Kuru network split unit by unit with the Kuru book where Kuru pays the seller more.
 */
export function SellNowPreview({
  selio,
  meta,
  assets,
  bids,
  useKuru,
  onPlan,
}: {
  selio: SelioClient;
  meta: MarketMeta;
  assets: bigint | null;
  bids: BidView[] | undefined;
  /** Plan through the Kuru book as well (Kuru networks, unless the seller chose Selio only). */
  useKuru: boolean;
  onPlan: (plan: PreviewPlan | null) => void;
}) {
  const U = meta.underlying;
  const mask = allPayMask(meta.payTokens.length);
  // Re-planned on every market poll: the bids array is the reload key.
  const plan = useAsync<PreviewPlan>(
    async () => {
      if (!useKuru) return { selio: await selio.planSellNow(assets ?? 0n, meta.maxDiscountBps, mask), routed: null, kuru: null };
      const [routed, market, face] = await Promise.all([
        selio.planRoutedSell(assets ?? 0n, meta.maxDiscountBps, mask),
        selio.kuruMarket(),
        selio.kuruFacePerBase(),
      ]);
      return { selio: routed.selio, routed, kuru: { market, face } };
    },
    [selio, meta, assets, useKuru],
    { enabled: assets !== null, reloadKey: bids },
  );
  const data = plan.data;
  useEffect(() => onPlan(data ?? null), [data, onPlan]);

  if (plan.error) {
    return (
      <Notice tone="danger">
        Can't plan the sale{useKuru ? " across Selio and Kuru" : ""}: {describeError(plan.error)}
      </Notice>
    );
  }

  const pending = assets !== null && !data;
  const value = (text: () => string) => (assets === null ? "—" : pending || !data ? "…" : text());
  const total = (bids ?? []).reduce((sum, b) => sum + b.capacityAssets, 0n);
  const routed = data?.routed ?? null;
  const kuruLeg = routed?.kuru ?? null;
  const filled = routed ? routed.filledAssets : (data?.selio.filledAssets ?? 0n);
  const average = routed ? routed.averageDiscountBps : (data?.selio.averageDiscountBps ?? 0);

  let note = kuruLeg
    ? "Selio's bids pay in the asset they escrowed and Kuru pays in " +
      U.symbol +
      ". One transaction sells both parts, and reverts as a whole if Kuru pays less than shown."
    : "Each bid pays in the asset it escrowed. You are paid in the same transaction.";
  if (assets === null) note = "Enter an amount to see the fills, best price first.";
  else if (data && filled < assets) {
    note = `${formatToken(assets - filled, U)} is more than the bids hold (${formatToken(total, U)}); run an auction for the rest.`;
  }

  const fees = data ? formatPlanAmounts(data.selio.fees, meta.payTokens, U) : "";
  const receive = data
    ? formatPlanAmounts(kuruLeg ? withAmount(data.selio.sellerNet, U.address, kuruLeg.expectedOut) : data.selio.sellerNet, meta.payTokens, U)
    : "";

  return (
    <div className="summary" data-testid="sell-preview">
      <SummaryRow label="Filled now" testid="sell-filled">
        {value(() => `${formatToken(filled, U)} of ${formatToken(assets ?? 0n, U)}`)}
      </SummaryRow>
      <Highlight label="Average discount" tone="warn" testid="sell-avg-discount">
        {data && filled > 0n ? formatBps(average) : "—"}
      </Highlight>
      {useKuru && (
        <SummaryRow label="Route" testid="sell-route">
          {value(() => (filled > 0n && routed ? ROUTE_LABEL[routed.route] : "—"))}
        </SummaryRow>
      )}
      {kuruLeg && data?.kuru && (
        <>
          <SummaryRow label="On Kuru" testid="sell-kuru-filled">
            {formatToken(kuruLeg.receiptAssets, U)} at {formatBps(kuruAverageDiscount(kuruLeg, data.kuru.face, data.kuru.market))}
          </SummaryRow>
          <SummaryRow label="From Kuru" testid="sell-kuru-receive">
            {formatToken(kuruLeg.expectedOut, U)}, at least {formatToken(kuruLeg.minOut, U)}
          </SummaryRow>
        </>
      )}
      <SummaryRow
        label={kuruLeg && data?.kuru ? routedFeeLabel(meta.feeBps, data.kuru.market.takerFeeBps) : feeLabel(meta.feeBps)}
        testid="sell-fee"
      >
        {value(() => fees)}
      </SummaryRow>
      <SummaryRow label="You receive" testid="sell-receive">
        <span className="text-good strong">{value(() => receive)}</span>
      </SummaryRow>
      <p className="small muted">{note}</p>
    </div>
  );
}

/**
 * The risk data of the Kuru market of this receipt: what one base unit is worth at face, Kuru's best bid, and the
 * pool's exit capacity behind every receipt traded there.
 */
export function KuruRiskPanel({
  meta,
  market,
  face,
  best,
  cap,
}: {
  meta: MarketMeta;
  market: KuruMarketInfo;
  face: bigint;
  best: KuruLevel | undefined;
  cap: CapacityView | undefined;
}) {
  const { info } = useNetwork();
  const U = meta.underlying;
  const explorer = info.explorerUrl ? `${info.explorerUrl.replace(/\/+$/, "")}/address/${market.book}` : null;
  return (
    <div className="summary" data-testid="kuru-risk">
      <span className="label">Kuru market</span>
      <SummaryRow label="Market">
        {explorer ? (
          <a href={explorer} target="_blank" rel="noreferrer">
            {shortAddress(market.book)} ↗
          </a>
        ) : (
          <span title={market.book}>{shortAddress(market.book)}</span>
        )}
      </SummaryRow>
      <SummaryRow label="Face value">
        1 {market.base.symbol} = {formatAmount(face, U.decimals, 6)} {U.symbol}
      </SummaryRow>
      <SummaryRow label="Best Kuru bid">{best ? `${formatBps(best.discountBps)} discount` : "No Kuru bids yet"}</SummaryRow>
      <SummaryRow label="Withdrawable now">{cap ? formatToken(cap.withdrawable, U) : "…"}</SummaryRow>
      <SummaryRow label="Utilization">{cap ? formatBps(cap.utilizationBps) : "…"}</SummaryRow>
      <SummaryRow label="Exit via borrowers">{cap ? formatToken(cap.debtorCapacity, U) : "…"}</SummaryRow>
      <p className="small muted">This is the exit capacity behind every receipt traded on this Kuru market.</p>
    </div>
  );
}
