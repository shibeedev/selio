import { useState } from "react";
import { encodeFunctionData, isAddressEqual, type Address } from "viem";
import { aavePoolAbi, type SelioClient } from "@selio/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { ArrowRight, Check, Cross } from "../../components/Icons";
import { Notice, Stat, SummaryRow, ToggleGroup } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { describeError } from "../../lib/errors";
import { estimateAaveHealthAfter, valueInBase } from "../../lib/estimates";
import { amountFor, feeLabel } from "../../lib/fees";
import { formatHealth, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { buildPayMask } from "../../lib/paymask";
import { approvalStep, useTxRunner, withATokenMargin, type TxStep } from "../../lib/tx";
import { aaveAccount, aaveVariableDebt, aavePoolPremiumBps, priceOf } from "../../lib/venue";
import { useWallet } from "../../lib/wallet-context";

const BPS = 10_000n;
/** The route leaves a few wei per bid unsold, so the requested amounts stay 0.1% under the preview. */
const SLACK_BPS = 10n;

type Action = "repay" | "swap";

/** Dry run of a plain Aave withdrawal of the same amount: null when it would succeed, else why it fails. */
async function directWithdrawBlocked(selio: SelioClient, asset: Address, amount: bigint, user: Address): Promise<string | null> {
  const pool = selio.deployment.aavePool;
  if (!pool) return "not an Aave deployment";
  try {
    await selio.client.call({
      account: user,
      to: pool,
      data: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [asset, amount, user] }),
    });
    return null;
  } catch (e) {
    return describeError(e);
  }
}

export function FrozenRoute({ selio, meta, route }: { selio: SelioClient; meta: MarketMeta; route: Address }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const U = meta.underlying;
  const R = meta.receipt;
  const [action, setAction] = useState<Action>("repay");
  const [tokenChoice, setTokenChoice] = useState<number | null>(null);
  const [amount, setAmount] = useState("");

  const position = useAsync(
    async () => {
      const user = address as Address;
      const [collateral, account, cap, premiumBps, debts] = await Promise.all([
        selio.balanceOf(R.address, user),
        aaveAccount(selio, user),
        selio.capacity(),
        aavePoolPremiumBps(selio),
        Promise.all(meta.payTokens.map((t) => aaveVariableDebt(selio, t.address, user).catch(() => null))),
      ]);
      return { collateral, account, withdrawable: cap.withdrawable, premiumBps, debts };
    },
    [selio, meta, address],
    { enabled: !!address, pollMs: 30_000, reloadKey: refreshKey },
  );
  const pos = position.data;

  const parsed = parseAmountInput(amount, U.decimals);
  const amountError =
    parsed.error ??
    (parsed.value !== null && pos && parsed.value > pos.collateral ? `You hold ${formatToken(pos.collateral, R)}` : null) ??
    (parsed.value === 0n ? "Enter more than zero" : null);
  const sellAmount = parsed.value !== null && parsed.value > 0n && !amountError ? parsed.value : null;

  // The frozen asset is never a choice: the route flash-borrows the debt asset from Aave, and a frozen pool cannot lend it.
  const others = meta.payTokens.map((_, i) => i).filter((i) => !isAddressEqual(meta.payTokens[i]!.address, U.address));
  const choices =
    action === "swap"
      ? others
      : others.filter((i) => {
          const debt = pos?.debts[i] ?? null;
          return debt === null || debt > 0n;
        });
  const payIdx = tokenChoice !== null && choices.includes(tokenChoice) ? tokenChoice : (choices[0] ?? null);
  const payToken = payIdx === null ? null : (meta.payTokens[payIdx] ?? null);
  const underlyingIdx = meta.payTokens.findIndex((t) => isAddressEqual(t.address, U.address));
  const sameAssetDebt = underlyingIdx >= 0 ? (pos?.debts[underlyingIdx] ?? null) : null;

  const checkAmount = sellAmount ?? pos?.collateral ?? 0n;
  const direct = useAsync(() => directWithdrawBlocked(selio, U.address, checkAmount, address as Address), [selio, address, checkAmount], {
    enabled: !!pos && checkAmount > 0n,
    reloadKey: refreshKey,
  });
  const directWorks = direct.data === null && !direct.loading;

  const plan = useAsync(
    () => selio.planSellNow(sellAmount as bigint, meta.maxDiscountBps, buildPayMask([payIdx as number])),
    [selio, sellAmount, payIdx],
    { enabled: sellAmount !== null && payIdx !== null, pollMs: 20_000, reloadKey: refreshKey },
  );
  const prices = useAsync(
    async () => {
      const [pu, pp] = await Promise.all([priceOf(selio, U.address), priceOf(selio, (payToken as { address: Address }).address)]);
      return { pu, pp };
    },
    [selio, payToken?.address],
    { enabled: payToken !== null },
  );

  // Proceeds net of the protocol fee: what the route receives.
  const proceeds = plan.data && payToken ? amountFor(plan.data.sellerNet, payToken.address) : null;
  const fee = plan.data && payToken ? amountFor(plan.data.fees, payToken.address) : null;
  const safe = proceeds === null ? null : (proceeds * (BPS - SLACK_BPS)) / BPS;
  const debt = payIdx === null ? null : (pos?.debts[payIdx] ?? null);
  let repay: bigint | null = null;
  let minProceeds: bigint | null = null;
  if (safe !== null && pos) {
    if (action === "repay") {
      const net = (safe * BPS) / (BPS + pos.premiumBps);
      // Interest accrues until inclusion and Aave repays at most the debt, so ask for 0.01% more than it.
      const all = debt === null ? null : debt + debt / BPS + 1n;
      repay = all !== null && all < net ? all : net;
    } else {
      minProceeds = safe;
    }
  }

  let healthAfter: bigint | null = null;
  if (pos && plan.data && prices.data && payToken) {
    const removed = valueInBase(plan.data.filledAssets, U.decimals, prices.data.pu);
    const base = {
      totalCollateralBase: pos.account.totalCollateralBase,
      totalDebtBase: pos.account.totalDebtBase,
      liquidationThresholdBps: pos.account.liquidationThresholdBps,
      collateralRemovedBase: removed,
    };
    healthAfter =
      action === "repay"
        ? estimateAaveHealthAfter({
            ...base,
            debtRepaidBase: repay === null ? 0n : valueInBase(repay, payToken.decimals, prices.data.pp),
          })
        : estimateAaveHealthAfter({
            ...base,
            collateralAddedBase: valueInBase(proceeds ?? 0n, payToken.decimals, prices.data.pp),
            debtRepaidBase: 0n,
          });
  }

  const busy = runner.state.busy !== null;
  const simulated = runner.state.outcome === "simulated" || runner.state.outcome === "partial";
  const ready =
    !!address && sellAmount !== null && payIdx !== null && !!plan.data && plan.data.filledAssets > 0n && !directWorks && !direct.loading;

  const build = async (): Promise<TxStep[]> => {
    const p = plan.data;
    if (!address || sellAmount === null || payIdx === null || !payToken || !p || p.filledAssets === 0n) {
      throw new Error("No bid can buy this collateral right now.");
    }
    const worst = p.fills.reduce((m, f) => Math.max(m, f.discountBps), 0);
    const approval = await approvalStep(selio, R, address, route, withATokenMargin(sellAmount, 1), "so the route can sell them for you");
    const main: TxStep =
      action === "repay"
        ? {
            label: `Sell up to ${formatToken(sellAmount, R)} and repay ${repay === null ? "debt" : formatToken(repay, payToken)}`,
            tx: selio.routeRepayWithFrozenCollateral(sellAmount, p, worst, payIdx, repay ?? 0n, repay ?? 0n),
          }
        : {
            label: `Sell up to ${formatToken(sellAmount, R)} and supply the proceeds as ${payToken.symbol} collateral`,
            tx: selio.routeSwapFrozenCollateral(sellAmount, p, worst, payIdx, minProceeds ?? 0n),
          };
    return approval ? [approval, main] : [main];
  };

  if (!address) return <Notice tone="neutral">Connect a wallet to load your Aave position.</Notice>;

  const debtText = pos
    ? meta.payTokens
        .map((t, i) => ({ t, d: pos.debts[i] ?? 0n }))
        .filter(({ d }) => d > 0n)
        .map(({ t, d }) => formatToken(d, t))
        .join(" + ") || "None in payment assets"
    : "…";
  const planned = (text: () => string) => (sellAmount === null || payIdx === null ? "—" : !plan.data ? "…" : text());

  let directDetail = "";
  if (pos) {
    if (directWorks) directDetail = " Use Aave directly; the fallback route only runs when a direct withdrawal fails.";
    else {
      directDetail = ` The pool has ${formatToken(pos.withdrawable, U)} withdrawable for every depositor combined.`;
      if (direct.data && pos.withdrawable >= (sellAmount ?? pos.collateral)) directDetail += ` ${direct.data}`;
    }
  }
  const directState = direct.loading ? "checking…" : directWorks ? "works." : "blocked.";

  const outcome =
    action === "repay"
      ? repay === null || !payToken
        ? "—"
        : debt !== null && repay >= debt
          ? `${formatToken(debt, payToken)}, all of it`
          : formatToken(repay, payToken)
      : minProceeds === null || !payToken
        ? "—"
        : `at least ${formatToken(minProceeds, payToken)}`;

  return (
    <div className="split split--top">
      <section className="card card--pad stack col-narrow" aria-labelledby="h-check">
        <h2 id="h-check" className="h2-sm">
          Your Aave position
        </h2>
        {position.error != null && <Notice tone="danger">Can't read your position: {describeError(position.error)}</Notice>}
        <div className="stats">
          <Stat label="Collateral" testid="frozen-collateral" value={pos ? formatToken(pos.collateral, R) : "…"} />
          <Stat label="Debt" testid="frozen-debt" value={debtText} />
          <Stat label="Health factor" testid="frozen-health" value={pos ? formatHealth(pos.account.healthFactor) : "…"} />
        </div>
        {pos?.collateral === 0n && <DemoFunds kits={["borrower"]} compact />}
        <ol className="checklist">
          <li>
            <span className={directWorks ? "check-icon check-icon--ok" : "check-icon check-icon--bad"}>
              {directWorks ? <Check size={16} /> : <Cross size={16} />}
            </span>
            <span data-testid="frozen-direct">
              <b>
                Withdraw {U.symbol} directly: {directState}
              </b>
              {directDetail}
            </span>
          </li>
          <li>
            <span className={simulated ? "check-icon check-icon--ok" : "check-icon check-icon--idle"}>
              <Check size={16} />
            </span>
            <span>
              <b>Simulate the sale through Selio:</b>{" "}
              {simulated ? "passed against the current block." : runner.state.outcome === "failed" ? "failed." : "not run yet."}
            </span>
          </li>
          <li>
            <span className="check-icon check-icon--idle">
              <ArrowRight size={16} />
            </span>
            <span>
              <b>Send:</b>{" "}
              {simulated && sellAmount !== null
                ? `ready. One transaction sells up to ${formatToken(sellAmount, R)} and ${
                    action === "repay" ? `repays your ${payToken?.symbol ?? ""} debt.` : "supplies the new collateral."
                  }`
                : "locked until the simulation passes."}
            </span>
          </li>
        </ol>
      </section>
      <section className="card card--pad card--feature stack col-wide" aria-labelledby="h-act">
        <h2 id="h-act" className="h2-sm">
          What do you need to do?
        </h2>
        <ToggleGroup<Action>
          label="Action"
          value={action}
          onChange={(next) => {
            setAction(next);
            setTokenChoice(null);
            runner.reset();
          }}
          options={[
            { value: "repay", label: "Repay debt", testid: "frozen-repay" },
            { value: "swap", label: "Swap collateral", testid: "frozen-swap" },
          ]}
        />
        <fieldset className="fieldset">
          <legend className="label">{action === "repay" ? "Debt to repay" : "New collateral"}</legend>
          {action === "repay" && sameAssetDebt !== null && sameAssetDebt > 0n && (
            <span className="hint" data-testid="frozen-same-asset-debt">
              Your {formatToken(sameAssetDebt, U)} debt is in the frozen asset itself: repay it with your {R.symbol} directly on Aave
              (repay with aTokens), which needs no pool liquidity.
            </span>
          )}
          {choices.length === 0 ? (
            <span className="hint">
              {action === "repay" ? `You have no debt, other than ${U.symbol}, in an asset the bids pay in.` : "No other payment asset to swap into."}
            </span>
          ) : (
            <div className="toggle-group">
              {choices.map((i) => {
                const t = meta.payTokens[i]!;
                const d = pos?.debts[i] ?? null;
                return (
                  <button
                    key={t.address}
                    type="button"
                    className="toggle toggle--pill"
                    aria-pressed={i === payIdx}
                    onClick={() => {
                      setTokenChoice(i);
                      runner.reset();
                    }}
                    data-testid={`frozen-token-${t.symbol}`}
                  >
                    {t.symbol}
                    {action === "repay" && d !== null ? ` · ${formatToken(d, t)}` : ""}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
        <AmountField
          id="route-amt"
          testid="frozen-amount"
          label={`${R.symbol} to sell through Selio`}
          value={amount}
          onChange={(v) => {
            setAmount(v);
            runner.reset();
          }}
          onMax={pos && pos.collateral > 0n ? () => setAmount(toInputString(pos.collateral, U.decimals)) : undefined}
          hint={`Sold to the best escrowed buyers, the Selio Vault or a limit bid, that pay in ${payToken?.symbol ?? "the chosen asset"}.`}
          error={amount ? amountError : null}
        />
        <div className="summary">
          <SummaryRow label={feeLabel(meta.feeBps)} testid="frozen-fee">
            {planned(() => formatToken(fee ?? 0n, payToken!))}
          </SummaryRow>
          <SummaryRow label="Proceeds after fee" testid="frozen-proceeds">
            <span className="text-good strong">{planned(() => formatToken(proceeds ?? 0n, payToken!))}</span>
          </SummaryRow>
          <SummaryRow label={action === "repay" ? `${payToken?.symbol ?? ""} debt repaid` : "New collateral supplied"} testid="frozen-outcome">
            {outcome}
          </SummaryRow>
          <SummaryRow label="Health factor after (estimate)" testid="frozen-health-after">
            {healthAfter === null ? "—" : formatHealth(healthAfter)}
          </SummaryRow>
          {plan.data && sellAmount !== null && plan.data.filledAssets < sellAmount && payToken && (
            <p className="small muted">
              Bids paying in {payToken.symbol} can take {formatToken(plan.data.filledAssets, U)} now; the rest stays with you.
            </p>
          )}
          {action === "repay" && (
            <p className="small muted">Unsold collateral and any surplus proceeds come back to you in the same transaction.</p>
          )}
        </div>
        {plan.error != null && <Notice tone="danger">Can't plan the sale: {describeError(plan.error)}</Notice>}
        {directWorks && (
          <Notice tone="info" testid="frozen-direct-works">
            The pool can pay this out directly, so withdraw on Aave instead. The fallback route only runs when a direct withdrawal
            fails.
          </Notice>
        )}
        {wallet.writeBlockedReason && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <div className="row-sm">
          <button
            type="button"
            className="btn btn--secondary btn--lg grow-1"
            disabled={!ready || busy}
            onClick={() => void runner.simulate(build)}
            data-testid="frozen-simulate"
          >
            Simulate
          </button>
          <button
            type="button"
            className="btn btn--primary btn--lg grow-2"
            disabled={!ready || !simulated || busy || !!wallet.writeBlockedReason}
            onClick={() => void runner.send(build)}
            data-testid="frozen-submit"
          >
            {simulated ? "Send transaction" : "Simulate first"}
          </button>
        </div>
        <TxStatus state={runner.state} />
      </section>
    </div>
  );
}
