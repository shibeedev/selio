import { useRef, useState } from "react";
import { isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { WAD, type SelioClient, type SessionView, type TokenInfo } from "@selio/sdk";
import { AmountField } from "../../components/AmountField";
import { Highlight, Notice, SummaryRow, ToggleGroup } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { describeError } from "../../lib/errors";
import {
  discountedValue,
  estimateAaveHealthAfter,
  estimateAaveRepay,
  estimateMorphoHealthAfter,
  valueInBase,
} from "../../lib/estimates";
import { formatBps, formatHealth, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { maskIncludes, maskIndices, morphoFlashPayIndex } from "../../lib/paymask";
import { hrefFor } from "../../lib/router";
import { approvalStep, useTxRunner, withATokenMargin, type TxStep } from "../../lib/tx";
import { aaveFlashTerms, priceOf } from "../../lib/venue";
import { useWallet } from "../../lib/wallet-context";
import type { BorrowerInfo } from "./BuyPage";

/** Morpho permission signatures are reused for this long per account. */
const AUTH_TTL_MS = 50 * 60 * 1000;

type PayMode = "wallet" | "flash";

/** A Vault V2 forced-deallocation penalty (1e18-scaled) as a percentage, precise enough for 0.001%. */
function formatPenalty(penaltyWad: bigint): string {
  return `${(Number(penaltyWad) / 1e16).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;
}

export function BuyPanel({
  selio,
  meta,
  session,
  borrower,
}: {
  selio: SelioClient;
  meta: MarketMeta;
  session: SessionView;
  borrower: BorrowerInfo | null;
}) {
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const U = meta.underlying;
  const R = meta.receipt;
  const morpho = meta.venue === "morpho";
  const noun = receiptNoun(meta);
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [mode, setMode] = useState<PayMode>("wallet");
  const [walletChoice, setWalletChoice] = useState<number | null>(null);
  const [flashChoice, setFlashChoice] = useState<number | null>(null);
  const authCache = useRef<{ auth: Hex; account: Address; at: number } | null>(null);

  // 1. Amount: until edited, the largest purchase the auction and the debt allow.
  const debt = borrower?.position.debt ?? 0n;
  const maxBuy = session.remainingAssets < debt ? session.remainingAssets : debt;
  const amount = amountInput ?? (maxBuy > 0n ? toInputString(maxBuy, U.decimals) : "");
  const parsed = parseAmountInput(amount, U.decimals);
  const amountError =
    parsed.error ??
    (parsed.value !== null && parsed.value > maxBuy ? `At most ${formatToken(maxBuy, U)}` : null) ??
    (parsed.value === 0n ? "Enter more than zero" : null);
  const validAssets = parsed.value !== null && parsed.value > 0n && !amountError ? parsed.value : null;

  // 2–5. Payment asset per mode.
  const payTokens = meta.payTokens;
  const accepted = maskIndices(session.payMask, payTokens.length);
  const morphoIdx = morphoFlashPayIndex(
    payTokens.map((t) => t.address),
    borrower?.position.market?.collateralToken,
  );
  const flashChoices = morpho
    ? morphoIdx !== null && accepted.includes(morphoIdx)
      ? [morphoIdx]
      : []
    : meta.aaveFlashPayIdx.filter((i) => maskIncludes(session.payMask, i));
  const walletIdx = walletChoice !== null && accepted.includes(walletChoice) ? walletChoice : (accepted[0] ?? 0);
  // On Aave the default flash payment is a collateral the buyer actually holds.
  const heldFlash = useAsync(
    async () => {
      const held: number[] = [];
      for (const i of flashChoices) {
        const aToken = selio.deployment.payATokens?.[i];
        if (aToken && (await selio.balanceOf(aToken, address as Address)) > 0n) held.push(i);
      }
      return held;
    },
    [selio, address, flashChoices.join(",")],
    { enabled: !morpho && !!address && flashChoices.length > 1 },
  );
  const flashIdx =
    flashChoice !== null && flashChoices.includes(flashChoice) ? flashChoice : (heldFlash.data?.[0] ?? flashChoices[0] ?? null);
  const payIdx = mode === "wallet" ? walletIdx : flashIdx;
  const payToken: TokenInfo | null = payIdx === null ? null : (payTokens[payIdx] ?? null);

  // 6–8. Reads.
  const quote = useAsync(
    () => selio.quote(validAssets as bigint, session.discountBps, (payToken as TokenInfo).address),
    [selio, validAssets, session.discountBps, payToken?.address],
    { enabled: validAssets !== null && payToken !== null },
  );
  const aaveTerms = useAsync(() => aaveFlashTerms(selio), [selio, session.id], { enabled: !morpho });
  const flashInfo = useAsync(
    async () => {
      if (morpho) return { aToken: null, balance: borrower?.position.collateral ?? 0n, pu: 0n, pp: 0n };
      const aTokenAddress = selio.deployment.payATokens?.[payIdx as number];
      if (!aTokenAddress || isAddressEqual(aTokenAddress, zeroAddress)) return null;
      const [aToken, balance, pu, pp] = await Promise.all([
        selio.token(aTokenAddress),
        selio.balanceOf(aTokenAddress, address as Address),
        priceOf(selio, U.address),
        priceOf(selio, (payToken as TokenInfo).address),
      ]);
      return { aToken: aToken as TokenInfo | null, balance, pu, pp };
    },
    [selio, address, payIdx, mode],
    { enabled: mode === "flash" && !!address && payToken !== null, reloadKey: borrower },
  );

  // 9. Debt repaid and savings.
  let debtRepaid: bigint | null = null;
  let repayNote: string | null = null;
  let repayBlocked: string | null = null;
  if (validAssets !== null) {
    if (morpho) {
      const force = borrower?.morphoForce;
      if (force?.force) {
        debtRepaid = (validAssets * WAD) / (WAD + force.penaltyWad);
        repayNote = `after a ${formatPenalty(force.penaltyWad)} forced-withdrawal penalty`;
      } else {
        debtRepaid = validAssets;
      }
    } else if (aaveTerms.data) {
      const estimate = estimateAaveRepay({ assets: validAssets, ...aaveTerms.data });
      if (estimate.ok) {
        debtRepaid = estimate.debtRepaid;
        if (estimate.flashFee > 0n) repayNote = `after a ${formatToken(estimate.flashFee, U)} Aave flash fee`;
      } else {
        repayBlocked = estimate.reason;
      }
    }
  }
  const payValue = validAssets === null ? null : discountedValue(validAssets, session.discountBps);
  const savings = debtRepaid !== null && payValue !== null ? debtRepaid - payValue : null;

  // 10. Health estimate in flash mode.
  let healthBefore: bigint | null = null;
  let healthAfter: bigint | null = null;
  if (mode === "flash" && borrower && quote.data !== undefined && debtRepaid !== null && payToken) {
    if (!morpho && borrower.aave && flashInfo.data) {
      healthBefore = borrower.aave.healthFactor;
      healthAfter = estimateAaveHealthAfter({
        totalCollateralBase: borrower.aave.totalCollateralBase,
        totalDebtBase: borrower.aave.totalDebtBase,
        liquidationThresholdBps: borrower.aave.liquidationThresholdBps,
        collateralRemovedBase: valueInBase(quote.data, payToken.decimals, flashInfo.data.pp),
        debtRepaidBase: valueInBase(debtRepaid, U.decimals, flashInfo.data.pu),
      });
    } else if (morpho && borrower.position.collateral !== undefined) {
      healthBefore = borrower.position.health;
      healthAfter = estimateMorphoHealthAfter({
        health: borrower.position.health,
        debt: borrower.position.debt,
        collateral: borrower.position.collateral,
        collateralRemoved: quote.data,
        debtRepaid,
      });
    }
  }

  // 11–12. Shortfall, approval and signature count.
  const collateralShort =
    mode === "flash" && !!flashInfo.data && quote.data !== undefined && flashInfo.data.balance < quote.data;
  const needsAuth = morpho && mode === "flash";
  const approvalToken = mode === "wallet" ? payToken : morpho ? null : (flashInfo.data?.aToken ?? null);
  const allowance = useAsync(
    () => selio.allowance((approvalToken as TokenInfo).address, address as Address, selio.market),
    [selio, approvalToken?.address, address, runner.state.outcome],
    { enabled: !!approvalToken && !!address },
  );
  const approvalAmount =
    quote.data === undefined ? 0n : mode === "flash" && !morpho ? withATokenMargin(quote.data, 1) : quote.data;
  const needsApproval = !!approvalToken && (allowance.data ?? 0n) < approvalAmount;
  const signatures = (needsApproval ? 1 : 0) + (needsAuth ? 2 : 0) + 1;

  const getAuth = async (): Promise<Hex> => {
    const cached = authCache.current;
    if (cached && address && cached.account === address && Date.now() - cached.at < AUTH_TTL_MS) return cached.auth;
    const signer = wallet.typedDataSigner();
    if (!signer || !address) throw new Error("Connect a wallet first.");
    const auth = await selio.signMorphoAuthorization(signer, address);
    authCache.current = { auth, account: address, at: Date.now() };
    return auth;
  };

  const build = async (): Promise<TxStep[]> => {
    if (!address || validAssets === null || payIdx === null || !payToken) throw new Error("Check the amount and payment.");
    const fresh = await selio.session(session.id);
    if (!fresh.open) throw new Error("This auction has ended or sold out.");
    // The discount only rises, so today's price is the most the purchase can cost.
    const maxPay = await selio.quote(validAssets, fresh.discountBps, payToken.address);
    let venueData: Hex = "0x";
    if (morpho) {
      const auth = mode === "flash" ? await getAuth() : undefined;
      venueData = await selio.venueData(address, { force: borrower?.morphoForce?.force ?? false, auth });
    }
    const label = `Buy ${formatToken(validAssets, U)} of ${noun} at ${formatBps(fresh.discountBps)} off and repay your debt`;
    if (mode === "wallet") {
      const approval = await approvalStep(selio, payToken, address, selio.market, maxPay, "so the market can pay the seller");
      const main = { label, tx: selio.buyAndRepay(session.id, validAssets, payIdx, maxPay, venueData) };
      return approval ? [approval, main] : [main];
    }
    const main = { label, tx: selio.buyAndRepayWithCollateral(session.id, validAssets, payIdx, maxPay, venueData) };
    if (morpho) return [main];
    const aTokenAddress = selio.deployment.payATokens?.[payIdx];
    if (!aTokenAddress || isAddressEqual(aTokenAddress, zeroAddress)) throw new Error("This asset cannot be paid from collateral.");
    const [aToken, margin] = await Promise.all([selio.token(aTokenAddress), selio.collateralPullMargin(payToken.address)]);
    const approval = await approvalStep(
      selio,
      aToken,
      address,
      selio.market,
      maxPay + margin,
      "so the market can pay the seller from your freed collateral",
    );
    return approval ? [approval, main] : [main];
  };

  const send = async () => {
    if (await runner.send(build)) {
      authCache.current = null;
      setAmountInput(null);
    }
  };

  const head = (
    <h2 id="h-panel" className="h2-sm">
      Buy &amp; repay · {noun} #{String(session.id)}
    </h2>
  );

  if (!address) {
    return (
      <section className="card card--pad card--feature col-narrow stack-sm" aria-labelledby="h-panel">
        {head}
        <Notice tone="neutral">Connect a wallet to see how much of your debt this auction can repay.</Notice>
      </section>
    );
  }
  if (borrower && debt === 0n) {
    return (
      <section className="card card--pad card--feature col-narrow stack-sm" aria-labelledby="h-panel">
        {head}
        <Notice tone="warn" testid="buy-no-debt">
          You have no {U.symbol} debt{morpho ? " in a market this vault supplies" : ""}, so this {noun} has nothing to repay. You
          can still buy it at a discount with a limit bid on Earn, and redeem it at full value when the pool refills.
        </Notice>
        <a className="btn btn--dark" href={hrefFor("earn")}>
          Place a limit bid
        </a>
      </section>
    );
  }

  const flashHow = morpho
    ? `Selio borrows ${U.symbol} for this one transaction, repays your debt, turns the seller's vault shares back into ${U.symbol} to return the loan, and pays the seller with the collateral your repayment frees.`
    : "Selio repays your debt first with a one-transaction loan, then pays the seller with the collateral that repayment frees.";
  const amt = validAssets === null ? `the amount in ${U.symbol}` : formatToken(validAssets, U);
  const paid = quote.data !== undefined && payToken ? formatToken(quote.data, payToken) : "the discounted price";
  const quoted = (text: (q: bigint) => string) =>
    validAssets === null || !payToken ? "—" : quote.data === undefined ? "…" : text(quote.data);
  const flashToken = flashInfo.data?.aToken ?? payToken ?? U;
  const busy = runner.state.busy !== null;
  const simulateDisabled = validAssets === null || busy || !payToken;
  const sendDisabled = simulateDisabled || !!wallet.writeBlockedReason || !!repayBlocked || collateralShort;

  return (
    <section className="card card--pad card--feature col-narrow stack" aria-labelledby="h-panel" data-testid="buy-panel">
      {head}
      <AmountField
        id="buy-amt"
        testid="buy-amount"
        label={`Repay amount (${U.symbol})`}
        value={amount}
        onChange={(v) => {
          setAmountInput(v);
          runner.reset();
        }}
        hint={`Up to ${formatToken(maxBuy, U)}: the smaller of what is left (${formatToken(session.remainingAssets, U)}) and your debt`}
        error={amount ? amountError : null}
      />
      <fieldset className="fieldset">
        <legend className="label">How to pay</legend>
        <ToggleGroup<PayMode>
          variant="dark"
          label="How to pay"
          value={mode}
          onChange={(next) => {
            setMode(next);
            runner.reset();
          }}
          options={[
            { value: "wallet", label: "From your wallet", testid: "buy-pay-wallet" },
            { value: "flash", label: "Flash loan · no cash needed", testid: "buy-pay-flash", disabled: flashChoices.length === 0 },
          ]}
        />
        <span className="hint">
          {flashChoices.length === 0
            ? morpho
              ? "Flash mode needs the seller to accept your market's collateral asset."
              : "Flash mode needs the seller to accept an asset you hold as Aave collateral."
            : `Flash loan: ${flashHow}`}
        </span>
      </fieldset>
      {mode === "wallet" ? (
        <fieldset className="fieldset">
          <legend className="label">Pay with</legend>
          <div className="toggle-group">
            {accepted.map((i) => {
              const t = payTokens[i];
              if (!t) return null;
              return (
                <button
                  key={t.address}
                  type="button"
                  className="toggle toggle--pill"
                  aria-pressed={i === walletIdx}
                  onClick={() => {
                    setWalletChoice(i);
                    runner.reset();
                  }}
                  data-testid={`buy-pay-token-${t.symbol}`}
                >
                  {t.symbol}
                </button>
              );
            })}
          </div>
          <span className="hint">The seller accepts these assets for this auction.</span>
        </fieldset>
      ) : (
        <div className="flash-box" data-testid="buy-flash-box">
          <p>
            <b>How the flash loan works:</b> {flashHow} It all happens in one transaction; if any step fails, nothing happens.
          </p>
          {flashChoices.length > 1 && (
            <div className="toggle-group">
              {flashChoices.map((i) => {
                const t = payTokens[i];
                if (!t) return null;
                return (
                  <button
                    key={t.address}
                    type="button"
                    className="toggle toggle--pill"
                    aria-pressed={i === flashIdx}
                    onClick={() => setFlashChoice(i)}
                    data-testid={`buy-flash-token-${t.symbol}`}
                  >
                    Pay with {t.symbol} collateral
                  </button>
                );
              })}
            </div>
          )}
          <SummaryRow label="Collateral that will be taken" testid="buy-flash-collateral">
            {quoted((q) => formatToken(q, payToken as TokenInfo))}
          </SummaryRow>
          <SummaryRow label="Cash needed up front" testid="buy-flash-cash">
            0
          </SummaryRow>
          <SummaryRow label="Health factor (estimate)" testid="buy-flash-health">
            {healthBefore !== null && healthAfter !== null ? `${formatHealth(healthBefore)} → ${formatHealth(healthAfter)}` : "…"}
          </SummaryRow>
          <p className="small">
            {morpho
              ? "You sign twice, with no gas: a one-time permission for Selio to move the collateral this repayment frees, and its revocation, which runs inside the same transaction."
              : `Works from a normal wallet: you approve Selio once to move your ${flashInfo.data?.aToken?.symbol ?? "collateral aToken"}. Reverts in full if that collateral's pool is frozen too, or if your health factor would drop.`}
          </p>
          {collateralShort && flashInfo.data && (
            <p className="small text-bad">
              You hold {formatToken(flashInfo.data.balance, flashToken)} of that collateral, less than the payment. Buy less, or pay
              from your wallet.
            </p>
          )}
        </div>
      )}
      <div className="summary">
        <SummaryRow label="You pay" testid="buy-you-pay">
          {quoted((q) => `${formatToken(q, payToken as TokenInfo)}${mode === "flash" ? " of your collateral" : ""}`)}
        </SummaryRow>
        <SummaryRow label="Debt repaid" testid="buy-debt-repaid">
          {debtRepaid === null ? (
            "—"
          ) : (
            <>
              {formatToken(debtRepaid, U)}
              {repayNote && <span className="summary-note"> ({repayNote})</span>}
            </>
          )}
        </SummaryRow>
        <Highlight label="You save" tone="good" testid="buy-savings">
          {savings === null ? "—" : formatToken(savings, U)}
        </Highlight>
        <p className="small muted">
          Bought at the auction's current discount, {formatBps(session.discountBps)}. It only rises, so waiting can only make it
          cheaper, but another borrower may buy first.
        </p>
      </div>
      {repayBlocked && <Notice tone="warn">{repayBlocked}</Notice>}
      {quote.error != null && <Notice tone="danger">Can't price this purchase: {describeError(quote.error)}</Notice>}
      {morpho && borrower?.morphoForce?.force && (
        <p className="small muted">
          Your market is not the vault's liquidity market, so Selio pulls the freed {U.symbol} out of it with a forced withdrawal;
          its penalty comes off the debt repaid.
        </p>
      )}
      <details className="details">
        <summary>What happens in the transaction</summary>
        <ol>
          <li>Selio borrows {amt} for this transaction only (a flash loan).</li>
          <li>
            It repays {amt} of your {morpho ? "Morpho" : "Aave"} debt with it, minus any flash fee.
          </li>
          <li>
            {morpho
              ? `That repayment frees ${U.symbol} in the market, so the seller's vault shares redeem for it, which returns the loan.`
              : `That repayment refills the pool, so the seller's ${R.symbol} turn back into ${U.symbol}, which returns the loan.`}
          </li>
          {mode === "wallet" ? (
            <>
              <li>You pay the seller {paid} from your wallet.</li>
              <li>Seller paid in full, or everything reverts.</li>
            </>
          ) : (
            <>
              <li>Your debt dropped, so part of your collateral unlocks; Selio sends {paid} of it to the seller.</li>
              <li>
                {morpho
                  ? "Your one-time permission is revoked in the same transaction; seller paid in full, or everything reverts."
                  : "Seller paid in full and your health factor did not fall, or everything reverts."}
              </li>
            </>
          )}
        </ol>
      </details>
      {wallet.writeBlockedReason && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
      {needsAuth && <p className="small muted">Simulating flash mode first asks for the two permission signatures.</p>}
      <div className="row-sm">
        <button
          type="button"
          className="btn btn--secondary btn--lg grow-1"
          disabled={simulateDisabled}
          onClick={() => void runner.simulate(build)}
          data-testid="buy-simulate"
        >
          Simulate
        </button>
        <button
          type="button"
          className="btn btn--primary btn--lg grow-2"
          disabled={sendDisabled}
          onClick={() => void send()}
          data-testid="buy-submit"
        >
          {runner.state.busy === "send" ? "Working…" : `Buy & repay · ${signatures} signature${signatures > 1 ? "s" : ""}`}
        </button>
      </div>
      <TxStatus state={runner.state} />
    </section>
  );
}
