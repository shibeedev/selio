import { useState } from "react";
import type { Address } from "viem";
import { kuruBaseAmount, kuruDiscountOfPrice, type SelioClient } from "@selio/sdk";
import { AmountField } from "../../components/AmountField";
import { Chip, Notice } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { describeError } from "../../lib/errors";
import { bpsToPercentInput, formatBps, formatToken, parseAmountInput, parsePercentToBps } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { kuruBidPlan, kuruPriceText, loadKuruBalances, loadKuruOrders } from "../../lib/kuru";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { approvalStep, useTxRunner, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

/**
 * A limit bid for the receipt on Kuru's order book: post-only at the highest price that keeps the chosen discount, sized
 * to the face value, funded from the bidder's Kuru margin account. Lists the bidder's Kuru orders to cancel them, and
 * withdraws what the margin account holds.
 */
export function KuruBidForm({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const ordersRunner = useTxRunner();
  const U = meta.underlying;
  const [size, setSize] = useState("");
  const [discount, setDiscount] = useState(bpsToPercentInput(200));

  const market = useAsync(
    async () => {
      const [m, face] = await Promise.all([selio.kuruMarket(), selio.kuruFacePerBase()]);
      return { m, face };
    },
    [selio],
    { pollMs: 30_000, reloadKey: refreshKey },
  );
  const funds = useAsync(
    async () => {
      const m = await selio.kuruMarket();
      const [held, margin] = await Promise.all([selio.balanceOf(m.quote.address, address as Address), loadKuruBalances(selio, m, address as Address)]);
      return { held, margin };
    },
    [selio, address],
    { enabled: !!address, pollMs: 20_000, reloadKey: refreshKey },
  );
  const orders = useAsync(() => loadKuruOrders(selio, address as Address), [selio, address], {
    enabled: !!address,
    pollMs: 20_000,
    reloadKey: refreshKey,
  });

  const m = market.data?.m;
  const face = market.data?.face;
  const parsedSize = parseAmountInput(size, U.decimals);
  const faceAssets = parsedSize.value !== null && parsedSize.value > 0n ? parsedSize.value : null;
  const discountBps = parsePercentToBps(discount);
  const discountValid = discountBps !== null && discountBps <= meta.maxDiscountBps;
  const plan = m && face !== undefined && faceAssets !== null && discountValid ? kuruBidPlan(faceAssets, discountBps as number, face, m) : null;
  const marginQuote = funds.data?.margin.quote;
  const need = plan && !plan.error && marginQuote !== undefined ? (plan.debit > marginQuote ? plan.debit - marginQuote : 0n) : null;
  const short = need !== null && funds.data !== undefined && need > funds.data.held;
  const busy = runner.state.busy !== null;
  const blocked = !!wallet.writeBlockedReason;
  const canPlace = !!address && !!plan && !plan.error && need !== null && !short && !busy && !blocked;

  const placeSteps = async (): Promise<TxStep[]> => {
    if (!address || !plan || plan.error || !m || faceAssets === null || discountBps === null) throw new Error("Check the bid.");
    const marginAccount = selio.deployment.kuruMarginAccount as Address;
    const balances = await loadKuruBalances(selio, m, address);
    const deposit = plan.debit > balances.quote ? plan.debit - balances.quote : 0n;
    const steps: TxStep[] = [];
    if (deposit > 0n) {
      const approval = await approvalStep(selio, m.quote, address, marginAccount, deposit, "so Kuru's margin account can hold the bid's funds");
      if (approval) steps.push(approval);
      steps.push({
        label: `Deposit ${formatToken(deposit, m.quote)} into your Kuru margin account`,
        tx: selio.kuruDeposit(m.quote.address, address, deposit),
      });
    }
    steps.push({
      label: `Bid on Kuru for up to ${formatToken(faceAssets, U)} at ${formatBps(discountBps)} off or more`,
      tx: selio.kuruPlaceBid(plan.price, plan.size, true),
    });
    return steps;
  };

  const place = async () => {
    if (await runner.send(placeSteps)) setSize("");
  };

  const cancel = (id: bigint) =>
    ordersRunner.send(async () => [
      { label: `Cancel Kuru bid #${id}; its unused funds go back to your Kuru margin account`, tx: selio.kuruCancel([id]) },
    ]);

  const withdraw = () =>
    ordersRunner.send(async () => {
      if (!address || !m) throw new Error("Connect a wallet first.");
      const balances = await loadKuruBalances(selio, m, address);
      const steps: TxStep[] = [];
      if (balances.quote > 0n) {
        steps.push({ label: `Withdraw ${formatToken(balances.quote, m.quote)} from Kuru`, tx: selio.kuruWithdraw(m.quote.address, balances.quote) });
      }
      if (balances.base > 0n) {
        steps.push({ label: `Withdraw ${formatToken(balances.base, m.base)} from Kuru`, tx: selio.kuruWithdraw(m.base.address, balances.base) });
      }
      if (steps.length === 0) throw new Error("Your Kuru margin account is empty.");
      return steps;
    });

  let priceText = "Enter a size and a discount to see the Kuru price.";
  if (market.error != null) priceText = `Can't read the Kuru market: ${describeError(market.error)}`;
  else if (plan && m) {
    priceText = `Kuru price ${kuruPriceText(plan.price, m)} per ${m.base.symbol}`;
    if (!plan.error) priceText += ` · funds needed ${formatToken(plan.debit, m.quote)}`;
    if (marginQuote !== undefined && funds.data) {
      priceText += ` · in your Kuru margin account ${formatToken(marginQuote, m.quote)}, in your wallet ${formatToken(funds.data.held, m.quote)}`;
    }
  }

  const rows = orders.data ?? [];
  const margin = funds.data?.margin;

  return (
    <>
      <section className="card card--pad card--feature stack" aria-labelledby="h-kuru-bid">
        <h2 id="h-kuru-bid" className="h2-sm">
          Place a limit bid on Kuru
        </h2>
        <p className="text-2">
          Bid for the same receipts on Kuru's order book, at the discount you choose. Sellers on Selio reach it through sell now
          wherever it pays them more than Selio's bids, and Kuru's own traders can fill it too.
        </p>
        <div className="field-row">
          <AmountField
            id="kuru-size"
            testid="kuru-bid-amount"
            label={`Buy up to (${U.symbol} face value)`}
            value={size}
            onChange={(v) => {
              setSize(v);
              runner.reset();
            }}
            error={size ? parsedSize.error : null}
          />
          <div className="field">
            <label className="label" htmlFor="kuru-disc">
              Only at a discount of at least (%)
            </label>
            <input
              id="kuru-disc"
              className="input input--mono"
              inputMode="decimal"
              value={discount}
              onChange={(e) => {
                setDiscount(e.target.value);
                runner.reset();
              }}
              aria-invalid={discountValid ? undefined : true}
              data-testid="kuru-bid-discount"
            />
            {discountValid ? (
              <span className="hint">The price is set so that a fill never costs more than this discount allows.</span>
            ) : (
              <span className="hint text-bad">Enter a discount from 0 to {formatBps(meta.maxDiscountBps, 0)}</span>
            )}
          </div>
        </div>
        <span className="hint" data-testid="kuru-bid-price">
          {priceText}
        </span>
        {plan?.error && <span className="hint text-bad">{plan.error}</span>}
        {short && m && <Notice tone="warn">You hold less {m.quote.symbol} than this bid needs on Kuru.</Notice>}
        {address && blocked && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <button type="button" className="btn btn--primary btn--lg" disabled={!canPlace} onClick={() => void place()} data-testid="kuru-bid-submit">
          {busy ? "Working…" : "Place bid on Kuru"}
        </button>
        <TxStatus state={runner.state} />
        <p className="small muted">
          A Kuru bid has a fixed price. As interest accrues, the same price becomes a deeper discount; if the receipt loses value, it
          becomes a shallower one. Re-price or cancel it here.
        </p>
      </section>
      <section className="card card--pad stack-sm" aria-labelledby="h-kuru-orders" data-testid="kuru-orders">
        <h2 id="h-kuru-orders" className="h2-sm">
          Your Kuru orders
        </h2>
        {!address ? (
          <p className="muted">Connect a wallet to see your Kuru orders.</p>
        ) : orders.error != null ? (
          <Notice tone="danger">Can't read your Kuru orders: {describeError(orders.error)}</Notice>
        ) : !orders.data ? (
          <p className="muted loading">Reading your Kuru orders…</p>
        ) : rows.length === 0 ? (
          <p className="muted">No Kuru bids yet. Bids you place on Kuru show up here.</p>
        ) : (
          <ul className="alert-list">
            {rows.map((o) => {
              const orderFace = m && face !== undefined ? (kuruBaseAmount(o.remainingSize, m) * face) / 10n ** BigInt(m.base.decimals) : null;
              const d = m && face !== undefined ? kuruDiscountOfPrice(o.price, face, m) : null;
              return (
                <li key={String(o.id)} data-testid={`kuru-order-${o.id}`} data-status={o.status}>
                  <span className="small">
                    Bid #{String(o.id)} · {o.status === "active" && orderFace !== null ? `${formatToken(orderFace, U)} left` : "filled"}
                    {d !== null && ` at ${formatBps(d)} below face now`}
                    {m && ` · ${kuruPriceText(o.price, m)}`}{" "}
                    <Chip tone={o.status === "active" ? "open" : "neutral"}>{o.status === "active" ? "Active" : "Filled"}</Chip>
                  </span>
                  {o.status === "active" && (
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      disabled={ordersRunner.state.busy !== null || blocked}
                      onClick={() => void cancel(o.id)}
                      data-testid={`kuru-cancel-${o.id}`}
                    >
                      Cancel
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {address && margin && m && (margin.quote > 0n || margin.base > 0n) && (
          <div className="row-sm">
            <span className="small muted">
              In your Kuru margin account: {formatToken(margin.quote, m.quote)} and {formatToken(margin.base, m.base)}
            </span>
            <button
              type="button"
              className="btn btn--secondary btn--small"
              disabled={ordersRunner.state.busy !== null || blocked}
              onClick={() => void withdraw()}
              data-testid="kuru-withdraw"
            >
              Withdraw from Kuru
            </button>
          </div>
        )}
        <TxStatus state={ordersRunner.state} />
      </section>
    </>
  );
}
