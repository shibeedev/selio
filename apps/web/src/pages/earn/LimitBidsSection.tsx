import { useState } from "react";
import { isAddressEqual, type Address } from "viem";
import type { BidView, IndexerClient, SelioClient } from "@selio/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { Notice } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { describeError } from "../../lib/errors";
import { bpsToPercentInput, formatBps, formatToken, parseAmountInput, parsePercentToBps } from "../../lib/format";
import { loadBidOrigins } from "../../lib/history";
import { useAsync } from "../../lib/hooks";
import { HISTORY_POLL_MS, indexerBidOrigins, useIndexer } from "../../lib/indexer";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { approvalStep, useTxRunner, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

export function LimitBidsSection({ selio, meta, bids }: { selio: SelioClient; meta: MarketMeta; bids?: BidView[] }) {
  const { info, refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const cancelRunner = useTxRunner();
  const U = meta.underlying;
  const [size, setSize] = useState("");
  const [discount, setDiscount] = useState(bpsToPercentInput(200));
  const [payIdx, setPayIdx] = useState(0);
  const payToken = meta.payTokens[payIdx];

  const parsedSize = parseAmountInput(size, U.decimals);
  const maxAssets = parsedSize.value !== null && parsedSize.value > 0n ? parsedSize.value : null;
  const discountBps = parsePercentToBps(discount);
  const discountValid = discountBps !== null && discountBps <= meta.maxDiscountBps;

  const escrow = useAsync(
    () => selio.quote(maxAssets as bigint, discountBps as number, payToken!.address),
    [selio, maxAssets, discountBps, payToken?.address],
    { enabled: maxAssets !== null && discountValid && !!payToken },
  );
  const balance = useAsync(() => selio.balanceOf(payToken!.address, address as Address), [selio, address, payToken?.address], {
    enabled: !!address && !!payToken,
    reloadKey: refreshKey,
  });
  // Each bid's whole size: from the event index on an indexed network (exact after resizes), else from the logs.
  const indexer = useIndexer();
  const origins = useAsync(
    () =>
      info.indexed
        ? indexerBidOrigins(indexer as IndexerClient, selio.market, address as Address)
        : loadBidOrigins(selio, address as Address),
    [selio, address, indexer],
    {
      enabled: !!address && (!info.indexed || indexer !== null),
      pollMs: info.indexed ? HISTORY_POLL_MS : undefined,
      reloadKey: refreshKey,
    },
  );

  const short = escrow.data !== undefined && balance.data !== undefined && escrow.data > balance.data;
  const busy = runner.state.busy !== null;
  const blocked = !!wallet.writeBlockedReason;
  const canPlace =
    !!address && maxAssets !== null && discountValid && escrow.data !== undefined && balance.data !== undefined && !short && !busy && !blocked;

  const placeSteps = async (): Promise<TxStep[]> => {
    if (!address || maxAssets === null || discountBps === null || !payToken) throw new Error("Check the bid.");
    const amount = await selio.quote(maxAssets, discountBps, payToken.address);
    const approval = await approvalStep(selio, payToken, address, selio.market, amount, "so the market can hold it in escrow");
    const main: TxStep = {
      label: `Escrow ${formatToken(amount, payToken)} and bid for up to ${formatToken(maxAssets, U)} at ${formatBps(discountBps)} off or more`,
      tx: selio.placeBid(discountBps, payIdx, maxAssets, amount),
    };
    return approval ? [approval, main] : [main];
  };

  const place = async () => {
    if (await runner.send(placeSteps)) setSize("");
  };

  const cancel = (bid: BidView) => {
    const token = meta.payTokens[bid.payIdx];
    return cancelRunner.send(async () => [
      {
        label: `Cancel bid #${bid.id} and get ${token ? formatToken(bid.escrow, token) : "the escrow"} back`,
        tx: selio.cancelBid(bid.id),
      },
    ]);
  };

  let escrowHint =
    escrow.data !== undefined && maxAssets !== null && discountBps !== null && payToken
      ? `Escrow needed: ${formatToken(escrow.data, payToken)}, enough to buy ${formatToken(maxAssets, U)} at ${formatBps(discountBps)} off.`
      : "Enter a size to see the escrow it needs.";
  if (balance.data !== undefined && payToken) escrowHint += ` You hold ${formatToken(balance.data, payToken)}.`;

  const mine = address ? (bids ?? []).filter((b) => isAddressEqual(b.bidder, address)) : [];

  return (
    <>
      <section className="card card--pad card--feature stack" aria-labelledby="h-place">
        <h2 id="h-place" className="h2-sm">
          Place a limit bid
        </h2>
        <p className="text-2">
          Buy stuck receipts at the discount you choose, then redeem them at full value when the pool refills. The bid sits in the
          same public book the Selio Vault uses.
        </p>
        <fieldset className="fieldset">
          <legend className="label">Receipt to buy</legend>
          <div className="toggle-group">
            <button type="button" className="toggle toggle--pill" aria-pressed="true">
              {receiptNoun(meta)}
            </button>
          </div>
        </fieldset>
        <div className="field-row">
          <AmountField
            id="ord-size"
            testid="bid-amount"
            label={`Buy up to (${U.symbol} face value)`}
            value={size}
            onChange={(v) => {
              setSize(v);
              runner.reset();
            }}
            error={size ? parsedSize.error : null}
          />
          <div className="field">
            <label className="label" htmlFor="ord-disc">
              Only at a discount of at least (%)
            </label>
            <input
              id="ord-disc"
              className="input input--mono"
              inputMode="decimal"
              value={discount}
              onChange={(e) => {
                setDiscount(e.target.value);
                runner.reset();
              }}
              aria-invalid={discountValid ? undefined : true}
              data-testid="bid-discount"
            />
            {discountValid ? (
              <span className="hint">Your bid never fills below this discount.</span>
            ) : (
              <span className="hint text-bad">Enter a discount from 0 to {formatBps(meta.maxDiscountBps, 0)}</span>
            )}
          </div>
        </div>
        <fieldset className="fieldset">
          <legend className="label">Escrow in</legend>
          <div className="toggle-group">
            {meta.payTokens.map((t, i) => (
              <button
                key={t.address}
                type="button"
                className="toggle toggle--pill"
                aria-pressed={i === payIdx}
                onClick={() => {
                  setPayIdx(i);
                  runner.reset();
                }}
                data-testid={`bid-escrow-${t.symbol}`}
              >
                {t.symbol}
              </button>
            ))}
          </div>
          <span className="hint" data-testid="bid-escrow-needed">
            {escrowHint}
          </span>
        </fieldset>
        {short && payToken && <Notice tone="warn">You hold less {payToken.symbol} than this bid needs in escrow.</Notice>}
        {escrow.error != null && <Notice tone="danger">Can't price the escrow: {describeError(escrow.error)}</Notice>}
        {address && blocked && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <button
          type="button"
          className="btn btn--primary btn--lg"
          disabled={!canPlace}
          onClick={() => void place()}
          data-testid="bid-submit"
        >
          {busy ? "Working…" : "Escrow and place bid"}
        </button>
        <TxStatus state={runner.state} />
        {address && balance.data === 0n && <DemoFunds kits={["bidder"]} compact />}
        <p className="small muted">
          Funds are escrowed when you place the bid, so sellers can count on it and it adds to the pool's exit capacity. Cancel
          anytime; it takes effect at once and the unused escrow comes straight back.
        </p>
      </section>
      <section className="card card--pad stack-sm" aria-labelledby="h-mybids">
        <h2 id="h-mybids" className="h2-sm">
          Your bids
        </h2>
        {!address ? (
          <p className="muted">Connect a wallet to see your bids.</p>
        ) : mine.length === 0 ? (
          <p className="muted">No open bids. Bids you place show up here.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Receipt</th>
                  <th scope="col">Filled</th>
                  <th scope="col">At least</th>
                  <th scope="col">Escrowed</th>
                  <th scope="col">
                    <span className="sr-only">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {mine.map((b) => {
                  const original = origins.data?.get(b.id);
                  const token = meta.payTokens[b.payIdx];
                  return (
                    <tr key={String(b.id)} data-testid={`bid-row-${b.id}`}>
                      <td className="cell-title">{receiptNoun(meta)}</td>
                      <td className="mono">
                        {original !== undefined
                          ? `${formatToken(original - b.maxAssets, U)} of ${formatToken(original, U)}`
                          : `up to ${formatToken(b.maxAssets, U)} left`}
                      </td>
                      <td className="mono">{formatBps(b.minDiscountBps)}</td>
                      <td className="mono">{token ? formatToken(b.escrow, token) : String(b.escrow)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          disabled={cancelRunner.state.busy !== null || blocked}
                          onClick={() => void cancel(b)}
                          data-testid={`bid-cancel-${b.id}`}
                        >
                          Cancel
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <TxStatus state={cancelRunner.state} />
      </section>
    </>
  );
}
