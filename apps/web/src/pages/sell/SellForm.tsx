import { useState } from "react";
import type { Address } from "viem";
import type { SelioClient } from "@selio/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { Notice } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { describeError } from "../../lib/errors";
import { formatAmount, formatBps, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { hasKuru } from "../../lib/kuru";
import { poolTitle, receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { venueLabel } from "../../lib/networks";
import { allPayMask } from "../../lib/paymask";
import { approvalStep, useTxRunner, withATokenMargin, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";
import { AuctionSettings, defaultAuctionInputs, deriveSessionParams, type AuctionInputs } from "./AuctionSettings";
import { KuruRiskPanel, SellNowPreview, type PreviewPlan } from "./SellNowPreview";

type Mode = "now" | "auction";

export function SellForm({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { info, refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const U = meta.underlying;
  const R = meta.receipt;
  const [mode, setMode] = useState<Mode>("now");
  const [amount, setAmount] = useState("");
  const [usingMax, setUsingMax] = useState(false);
  const [auction, setAuction] = useState<AuctionInputs>(() => defaultAuctionInputs(meta));
  const [preview, setPreview] = useState<PreviewPlan | null>(null);
  // On a Kuru network sell now also routes through the Kuru book, unless the seller falls back to Selio only.
  const kuruNetwork = hasKuru(selio);
  const [selioOnly, setSelioOnly] = useState(false);
  const useKuru = kuruNetwork && !selioOnly;

  const position = useAsync(
    async () => {
      const [value, units] = await Promise.all([selio.receiptValueOf(address!), selio.balanceOf(R.address, address!)]);
      return { value, units };
    },
    [selio, address],
    { enabled: !!address, pollMs: 20_000, reloadKey: refreshKey },
  );
  const market = useAsync(
    async () => {
      const [cap, bids] = await Promise.all([selio.capacity(), selio.bids()]);
      return { cap, bids };
    },
    [selio],
    { pollMs: 15_000, reloadKey: refreshKey },
  );
  const kuru = useAsync(
    async () => {
      const [m, face, book] = await Promise.all([selio.kuruMarket(), selio.kuruFacePerBase(), selio.kuruBook()]);
      return { m, face, best: book[0] };
    },
    [selio],
    { enabled: kuruNetwork, pollMs: 15_000, reloadKey: refreshKey },
  );

  const balance = position.data?.value;
  const parsed = parseAmountInput(amount, U.decimals);
  const amountError =
    parsed.error ??
    (parsed.value !== null && balance !== undefined && parsed.value > balance ? `You hold ${formatToken(balance, U)}` : null) ??
    (parsed.value === 0n ? "Enter more than zero" : null);
  const validAssets = parsed.value !== null && parsed.value > 0n && !amountError ? parsed.value : null;
  const { params, error: paramsError } = deriveSessionParams(auction, meta);
  const bestBid = market.data?.bids.find((b) => b.capacityAssets > 0n);
  const util = market.data?.cap.utilizationBps;
  const busy = runner.state.busy !== null;

  const routedSteps = async (account: Address): Promise<TxStep[]> => {
    const routed = preview?.routed;
    if (!routed?.kuru) throw new Error("No bid can fill this sale right now.");
    const router = selio.deployment.kuruSellRouter as Address;
    // The Selio leg keeps the rule of a plain sell-now: capped at the worst previewed discount.
    const worst = routed.selio.fills.reduce((m, f) => Math.max(m, f.discountBps), 0);
    const approval = await approvalStep(
      selio,
      R,
      account,
      router,
      await selio.routedSellApproval(routed),
      "so the router can sell them for you on Selio and Kuru",
    );
    const n = routed.selio.fills.length;
    const main: TxStep = {
      label:
        n > 0
          ? `Sell ${formatToken(routed.filledAssets, U)} into ${n} bid${n > 1 ? "s" : ""} and the Kuru order book`
          : `Sell ${formatToken(routed.filledAssets, U)} on the Kuru order book`,
      tx: selio.routedSell({ ...routed, maxDiscountBps: worst }, account),
    };
    return approval ? [approval, main] : [main];
  };

  const sellNowSteps = async (): Promise<TxStep[]> => {
    if (address && preview?.routed?.kuru) return routedSteps(address);
    const plan = preview?.selio;
    if (!address || !plan || plan.filledAssets === 0n) throw new Error("No bid can fill this sale right now.");
    const worst = plan.fills.reduce((m, f) => Math.max(m, f.discountBps), 0);
    // aTokens and vault shares both round up per fill, so the allowance carries a margin per fill.
    const allowance =
      meta.venue === "aave"
        ? withATokenMargin(plan.filledAssets, plan.fills.length)
        : (await selio.receiptAmountFor(plan.filledAssets)) + BigInt(plan.fills.length);
    const approval = await approvalStep(selio, R, address, selio.market, allowance, "so the market can hand them to the buyers");
    const n = plan.fills.length;
    // The previewed bids, capped at the worst previewed discount, all-or-nothing.
    const main: TxStep = {
      label: `Sell ${formatToken(plan.filledAssets, U)} into ${n} bid${n > 1 ? "s" : ""}`,
      tx: selio.sellNow(plan, worst, allPayMask(meta.payTokens.length), plan.filledAssets),
    };
    return approval ? [approval, main] : [main];
  };

  const auctionSteps = async (): Promise<TxStep[]> => {
    if (!address || !validAssets || !params) throw new Error(paramsError ?? "Check the auction settings.");
    // The Max button escrows the exact receipt balance.
    const receiptAmount = usingMax ? await selio.balanceOf(R.address, address) : await selio.receiptAmountFor(validAssets);
    const allowance = meta.venue === "aave" ? withATokenMargin(receiptAmount, 1) : receiptAmount;
    const approval = await approvalStep(selio, R, address, selio.market, allowance, "so the market can hold them in escrow");
    const main: TxStep = {
      label: `Open an auction for ${formatToken(validAssets, U)}`,
      tx: selio.openSession(receiptAmount, params),
    };
    return approval ? [approval, main] : [main];
  };

  const previewFilled = preview ? (preview.routed ? preview.routed.filledAssets : preview.selio.filledAssets) : 0n;
  const canSubmit =
    !!address &&
    !wallet.writeBlockedReason &&
    !busy &&
    (mode === "now" ? !!(preview && previewFilled > 0n && validAssets) : !!(validAssets && params));
  // A failed routed sale (Kuru paused, paying less than planned) can still go to Selio's bids alone.
  const offerSelioOnly = useKuru && mode === "now" && runner.state.outcome === "failed" && !!preview?.routed?.kuru;

  const chooseMode = (next: Mode) => {
    setMode(next);
    runner.reset();
  };

  const positionValue = position.error != null ? "—" : balance === undefined ? "…" : formatToken(balance, U);
  const shares =
    meta.venue === "morpho" && position.data ? ` · ${formatAmount(position.data.units, R.decimals)} shares` : "";

  return (
    <div className="split split--top">
      <section className="stack col-narrow" aria-labelledby="h-pos">
        <h2 id="h-pos" className="h2-sm">
          1. Pick a position
        </h2>
        {!address ? (
          <Notice tone="neutral">Connect a wallet to load the position you want to sell.</Notice>
        ) : (
          <>
            <button type="button" className="choice choice--card" aria-pressed="true" data-testid="sell-position">
              <span className="choice-row">
                <span className="choice-title">{receiptNoun(meta)}</span>
                <span className="mono" data-testid="sell-position-balance">
                  {positionValue}
                </span>
              </span>
              <span className="choice-desc">
                {venueLabel(info)} · {poolTitle(meta)} pool {util === undefined ? "" : `${formatBps(util)} utilized`}
                {shares}
              </span>
            </button>
            {position.error != null && (
              <Notice tone="danger">Can't read your position: {describeError(position.error)}</Notice>
            )}
            {balance === 0n && (
              <div className="stack-sm">
                <Notice tone="neutral">
                  You hold no {receiptNoun(meta)} on {info.label}, so there is nothing to sell here yet.
                </Notice>
                <DemoFunds kits={["seller"]} compact />
              </div>
            )}
          </>
        )}
      </section>
      <section className="card card--pad stack col-wide" aria-labelledby="h-how-sell">
        <h2 id="h-how-sell" className="h2-sm">
          2. Choose how to sell
        </h2>
        <div className="choices" role="group" aria-label="How to sell">
          <button
            type="button"
            className="choice"
            aria-pressed={mode === "now"}
            onClick={() => chooseMode("now")}
            data-testid="sell-mode-now"
          >
            <span className="choice-title">Sell now</span>
            <span className="choice-desc">
              {useKuru
                ? "Fill against Selio's limit bids, the Selio Vault and the Kuru order book, best price per unit. "
                : "Fill against limit bids and the Selio Vault, best price first. "}
              {bestBid ? `Best bid: ${formatBps(bestBid.minDiscountBps)} discount.` : "No bids right now."}
              {useKuru && " "}
              {useKuru && (
                <span data-testid="sell-kuru-best">
                  {kuru.data
                    ? kuru.data.best
                      ? `Kuru best bid: ${formatBps(kuru.data.best.discountBps)} discount, ${formatToken(kuru.data.best.faceAssets, U)}`
                      : "Kuru best bid: none yet"
                    : "Kuru best bid: …"}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className="choice"
            aria-pressed={mode === "auction"}
            onClick={() => chooseMode("auction")}
            data-testid="sell-mode-auction"
          >
            <span className="choice-title">Run an auction</span>
            <span className="choice-desc">
              Discount starts at {auction.start || "…"}% and rises until a borrower, the Selio Vault or a limit bid buys. Withdraw
              what is unsold anytime.
            </span>
          </button>
        </div>
        <AmountField
          id="sell-amt"
          testid="sell-amount"
          label={`Amount of ${receiptNoun(meta)} to sell (${U.symbol} value)`}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            setUsingMax(false);
            runner.reset();
          }}
          onMax={
            balance !== undefined && balance > 0n
              ? () => {
                  setAmount(toInputString(balance, U.decimals));
                  setUsingMax(true);
                  runner.reset();
                }
              : undefined
          }
          hint={balance !== undefined ? `You hold ${formatToken(balance, U)}` : undefined}
          error={amount ? amountError : null}
        />
        {mode === "now" ? (
          <SellNowPreview
            selio={selio}
            meta={meta}
            assets={validAssets}
            bids={market.data?.bids}
            useKuru={useKuru}
            onPlan={setPreview}
            onSelioOnly={() => {
              setSelioOnly(true);
              runner.reset();
            }}
          />
        ) : (
          <AuctionSettings
            selio={selio}
            meta={meta}
            assets={validAssets}
            bids={market.data?.bids ?? []}
            kuruBestBps={kuru.data?.best?.discountBps ?? null}
            inputs={auction}
            onChange={(next) => {
              setAuction(next);
              runner.reset();
            }}
          />
        )}
        {address && wallet.writeBlockedReason && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={!canSubmit}
          onClick={() => void runner.send(mode === "now" ? sellNowSteps : auctionSteps)}
          data-testid="sell-submit"
        >
          {busy ? "Working…" : mode === "now" ? "Sell now" : "Open auction"}
        </button>
        <TxStatus state={runner.state} />
        {offerSelioOnly && (
          <button
            type="button"
            className="btn btn--secondary self-start"
            onClick={() => {
              setSelioOnly(true);
              runner.reset();
            }}
            data-testid="sell-selio-only"
          >
            Sell on Selio only
          </button>
        )}
        {kuruNetwork && kuru.data && (
          <KuruRiskPanel meta={meta} market={kuru.data.m} face={kuru.data.face} best={kuru.data.best} cap={market.data?.cap} />
        )}
        {kuru.error != null && <p className="small muted">The Kuru market could not be read: {describeError(kuru.error)}</p>}
      </section>
    </div>
  );
}
