import type { BidView, SelioClient, SessionParams } from "@selio/sdk";
import { Notice, SummaryRow } from "../../components/ui";
import { secondsToReach, validateSessionParams } from "../../lib/auction";
import { describeError } from "../../lib/errors";
import { auctionFeeRows, feeLabel } from "../../lib/fees";
import { formatBps, formatDuration, parsePercentToBps } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { buildPayMask } from "../../lib/paymask";

export interface AuctionInputs {
  start: string;
  step: string;
  everyMinutes: string;
  cap: string;
  hours: string;
  payIdx: number[];
}

// The BRD leaves the curve open; these defaults reach a 3% bid in about 2.5 hours.
export function defaultAuctionInputs(meta: MarketMeta): AuctionInputs {
  return { start: "0.50", step: "0.25", everyMinutes: "15", cap: "5.00", hours: "24", payIdx: meta.payTokens.map((_, i) => i) };
}

export function deriveSessionParams(inputs: AuctionInputs, meta: MarketMeta): { params: SessionParams | null; error: string | null } {
  const startBps = parsePercentToBps(inputs.start);
  const stepBps = parsePercentToBps(inputs.step);
  const capBps = parsePercentToBps(inputs.cap);
  if (startBps === null || stepBps === null || capBps === null) {
    return { params: null, error: "Discounts are percentages with up to two decimals" };
  }
  const minutes = Number(inputs.everyMinutes);
  const hours = Number(inputs.hours);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isFinite(hours) || hours <= 0) {
    return { params: null, error: "Interval and duration must be positive numbers" };
  }
  const params: SessionParams = {
    startBps,
    stepBps,
    stepInterval: Math.round(minutes * 60),
    capBps,
    duration: Math.round(hours * 3_600),
    payMask: buildPayMask(inputs.payIdx),
  };
  const error = validateSessionParams(params, {
    maxDiscountBps: meta.maxDiscountBps,
    maxDurationSeconds: meta.maxSessionDuration,
    payTokenCount: meta.payTokens.length,
  });
  return error ? { params: null, error } : { params, error: null };
}

const FIELDS: { field: keyof Omit<AuctionInputs, "payIdx">; id: string; label: string; suffix: string }[] = [
  { field: "start", id: "auction-start", label: "Start discount", suffix: "%" },
  { field: "step", id: "auction-step", label: "Rises by", suffix: "%" },
  { field: "everyMinutes", id: "auction-every", label: "Every", suffix: "min" },
  { field: "cap", id: "auction-cap", label: "Never above", suffix: "%" },
  { field: "hours", id: "auction-hours", label: "Run for", suffix: "h" },
];

const when = (seconds: number) => (seconds === 0 ? "at once" : `after ${formatDuration(seconds)}`);

function pathSentence(p: SessionParams, bids: readonly BidView[], meta: MarketMeta, kuruBestBps: number | null): string {
  const curve = { startBps: p.startBps, stepBps: p.stepBps, stepInterval: p.stepInterval, capBps: p.capBps };
  const toCap = secondsToReach(curve, p.capBps);
  const parts = [
    `Starts at ${formatBps(p.startBps)}, rises ${formatBps(p.stepBps)} every ${formatDuration(p.stepInterval)} up to ${formatBps(p.capBps)}${
      toCap ? ` (after ${formatDuration(toCap)})` : ""
    }.`,
  ];
  const best = bids.find((b) => b.capacityAssets > 0n);
  const toBest = best ? secondsToReach(curve, best.minDiscountBps) : null;
  if (best && toBest !== null) parts.push(`Reaches the best limit bid (${formatBps(best.minDiscountBps)}) ${when(toBest)}.`);
  // An auction cannot sell into Kuru; the seller can compare with Kuru's best bid before opening one.
  if (kuruBestBps !== null) parts.push(`Kuru best bid now: ${formatBps(kuruBestBps)}.`);
  const vaultMin = formatBps(meta.vault.minDiscountBps);
  const toVault = secondsToReach(curve, meta.vault.minDiscountBps);
  parts.push(
    toVault === null ? `Never reaches the Selio Vault's ${vaultMin} minimum.` : `Reaches the Selio Vault's ${vaultMin} ${when(toVault)}.`,
  );
  parts.push(`Ends after ${formatDuration(p.duration)}; borrowers can buy at any moment until then.`);
  return parts.join(" ");
}

/** Accepted payment assets, the discount curve, where it meets the standing bids, and the fee before opening. */
export function AuctionSettings({
  selio,
  meta,
  assets,
  bids,
  kuruBestBps = null,
  inputs,
  onChange,
}: {
  selio: SelioClient;
  meta: MarketMeta;
  assets: bigint | null;
  bids: BidView[];
  /** Discount of the Kuru book's best bid, on a Kuru network. */
  kuruBestBps?: number | null;
  inputs: AuctionInputs;
  onChange: (inputs: AuctionInputs) => void;
}) {
  const U = meta.underlying;
  const { params, error } = deriveSessionParams(inputs, meta);
  const flashIdx =
    meta.venue === "aave"
      ? meta.aaveFlashPayIdx
      : meta.payTokens.map((t, i) => (t.address.toLowerCase() === U.address.toLowerCase() ? -1 : i)).filter((i) => i >= 0);
  const flashSymbols = flashIdx.map((i) => meta.payTokens[i]?.symbol).filter(Boolean);

  const quotes = useAsync(
    async () => {
      const [atStart, atCap] = await Promise.all([
        selio.sellerQuote(assets!, params!.startBps, U.address),
        selio.sellerQuote(assets!, params!.capBps, U.address),
      ]);
      return { atStart, atCap };
    },
    [selio, assets, params?.startBps, params?.capBps],
    { enabled: assets !== null && params !== null },
  );

  const togglePay = (i: number) => {
    const next = inputs.payIdx.includes(i) ? inputs.payIdx.filter((j) => j !== i) : [...inputs.payIdx, i].sort((a, b) => a - b);
    onChange({ ...inputs, payIdx: next });
  };

  const rows = quotes.data && params ? auctionFeeRows(quotes.data.atStart, quotes.data.atCap, params.startBps, params.capBps, U) : null;
  const value = (text: string | undefined) => (assets === null || !params ? "—" : (text ?? "…"));

  return (
    <div className="stack-sm">
      <fieldset className="fieldset">
        <legend className="label">Get paid in</legend>
        <div className="toggle-group">
          {meta.payTokens.map((t, i) => (
            <button
              key={t.address}
              type="button"
              className="toggle toggle--pill"
              aria-pressed={inputs.payIdx.includes(i)}
              onClick={() => togglePay(i)}
              data-testid={`sell-pay-${t.symbol}`}
            >
              {t.symbol}
            </button>
          ))}
        </div>
        <span className="hint">
          Accept more assets to reach more buyers. The Selio Vault pays in {meta.vault.asset.symbol}
          {flashSymbols.length > 0 && `; borrowers in flash mode pay with freed ${flashSymbols.join(" or ")} collateral`}.
        </span>
      </fieldset>
      <fieldset className="fieldset">
        <legend className="label">Auction settings</legend>
        <div className="field-grid">
          {FIELDS.map((f) => (
            <div key={f.id} className="field">
              <label className="label" htmlFor={f.id}>
                {f.label}
              </label>
              <div className="input-row">
                <input
                  id={f.id}
                  className="input input--mono"
                  inputMode="decimal"
                  value={inputs[f.field]}
                  onChange={(e) => onChange({ ...inputs, [f.field]: e.target.value })}
                  data-testid={f.id}
                />
                <span className="input-suffix">{f.suffix}</span>
              </div>
            </div>
          ))}
        </div>
      </fieldset>
      <p className={error ? "small text-bad" : "small muted"} data-testid="auction-path">
        {error ?? (params ? pathSentence(params, bids, meta, kuruBestBps) : "")}
      </p>
      {quotes.error ? (
        <Notice tone="danger">Can't price the auction: {describeError(quotes.error)}</Notice>
      ) : (
        <div className="summary">
          <SummaryRow label={feeLabel(meta.feeBps)} testid="auction-fee">
            {value(rows?.fee)}
          </SummaryRow>
          <SummaryRow label="You receive" testid="auction-receive">
            <span className="text-good strong">{value(rows?.receive)}</span>
          </SummaryRow>
          <p className="small muted">
            Shown in {U.symbol} value. A buyer paying in another accepted asset pays the same value in that asset, and the fee is
            taken in that asset.
          </p>
        </div>
      )}
    </div>
  );
}
