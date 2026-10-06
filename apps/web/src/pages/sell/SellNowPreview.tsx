import { useEffect } from "react";
import type { BidView, SelioClient, SellPlan } from "@selio/sdk";
import { Highlight, Notice, SummaryRow } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { feeLabel, formatPlanAmounts } from "../../lib/fees";
import { formatBps, formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { allPayMask } from "../../lib/paymask";

/** Best-price-first fills of the amount into escrowed bids, every payment asset, up to the market's maximum discount. */
export function SellNowPreview({
  selio,
  meta,
  assets,
  bids,
  onPlan,
}: {
  selio: SelioClient;
  meta: MarketMeta;
  assets: bigint | null;
  bids: BidView[] | undefined;
  onPlan: (plan: SellPlan | null) => void;
}) {
  const U = meta.underlying;
  // Re-planned on every market poll: the bids array is the reload key.
  const plan = useAsync(
    () => selio.planSellNow(assets ?? 0n, meta.maxDiscountBps, allPayMask(meta.payTokens.length)),
    [selio, meta, assets],
    { enabled: assets !== null, reloadKey: bids },
  );
  const data = plan.data;
  useEffect(() => onPlan(data ?? null), [data, onPlan]);

  if (plan.error) return <Notice tone="danger">Can't plan the sale: {describeError(plan.error)}</Notice>;

  const pending = assets !== null && !data;
  const value = (text: () => string) => (assets === null ? "—" : pending || !data ? "…" : text());
  const total = (bids ?? []).reduce((sum, b) => sum + b.capacityAssets, 0n);
  const filled = data?.filledAssets ?? 0n;

  let note = "Each bid pays in the asset it escrowed. You are paid in the same transaction.";
  if (assets === null) note = "Enter an amount to see the fills, best price first.";
  else if (data && filled < assets) {
    note = `${formatToken(assets - filled, U)} is more than the bids hold (${formatToken(total, U)}); run an auction for the rest.`;
  }

  return (
    <div className="summary" data-testid="sell-preview">
      <SummaryRow label="Filled now" testid="sell-filled">
        {value(() => `${formatToken(filled, U)} of ${formatToken(assets ?? 0n, U)}`)}
      </SummaryRow>
      <Highlight label="Average discount" tone="warn" testid="sell-avg-discount">
        {data && filled > 0n ? formatBps(data.averageDiscountBps) : "—"}
      </Highlight>
      <SummaryRow label={feeLabel(meta.feeBps)} testid="sell-fee">
        {value(() => formatPlanAmounts(data!.fees, meta.payTokens, U))}
      </SummaryRow>
      <SummaryRow label="You receive" testid="sell-receive">
        <span className="text-good strong">{value(() => formatPlanAmounts(data!.sellerNet, meta.payTokens, U))}</span>
      </SummaryRow>
      <p className="small muted">{note}</p>
    </div>
  );
}
