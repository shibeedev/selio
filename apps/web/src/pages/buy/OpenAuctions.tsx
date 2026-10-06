import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatDuration, formatToken } from "../../lib/format";
import type { AsyncState } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import type { OpenSessions } from "./BuyPage";

/** Open auctions, newest first, with how much of the buyer's debt each can repay. */
export function OpenAuctions({
  meta,
  open,
  debt,
  currentId,
  onSelect,
}: {
  meta: MarketMeta;
  open: AsyncState<OpenSessions>;
  debt: bigint | undefined;
  currentId: bigint | null;
  onSelect: (id: bigint) => void;
}) {
  const U = meta.underlying;
  const data = open.data;
  return (
    <section className="card card--pad stack col-wide" aria-labelledby="h-sess">
      <h2 id="h-sess" className="h2-sm">
        Open auctions
      </h2>
      {open.error != null && <Notice tone="danger">Can't read auctions: {describeError(open.error)}</Notice>}
      {!data && open.error == null && <p className="muted loading">Reading open auctions…</p>}
      {data && data.sessions.length === 0 && (
        <p className="muted" data-testid="buy-no-sessions">
          No open auctions yet. Sellers open them from Sell; the discount rises until someone buys.
        </p>
      )}
      {data && data.sessions.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Receipt</th>
                <th scope="col">Remaining</th>
                <th scope="col">Discount now</th>
                <th scope="col">Your matching debt</th>
                <th scope="col">
                  <span className="sr-only">Select</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.sessions.map((s) => {
                const selected = s.id === currentId;
                const matching =
                  debt === undefined
                    ? "Connect wallet"
                    : debt === 0n
                      ? "None"
                      : formatToken(debt < s.remainingAssets ? debt : s.remainingAssets, U);
                return (
                  <tr key={String(s.id)} className={selected ? "row-selected" : undefined} data-testid={`buy-session-row-${s.id}`}>
                    <td>
                      <div className="cell-title">{receiptNoun(meta)}</div>
                      <div className="cell-sub">
                        #{String(s.id)} · open {formatDuration(data.chainNow - s.startedAt)}
                      </div>
                    </td>
                    <td className="mono">{formatToken(s.remainingAssets, U)}</td>
                    <td className="mono text-good strong" data-testid={`buy-session-discount-${s.id}`}>
                      {formatBps(s.discountBps)}
                    </td>
                    <td className="mono">{matching}</td>
                    <td>
                      <button
                        type="button"
                        className={selected ? "btn btn--primary btn--small" : "btn btn--secondary btn--small"}
                        aria-pressed={selected}
                        onClick={() => onSelect(s.id)}
                        data-testid={`buy-select-${s.id}`}
                      >
                        {selected ? "Selected" : "Select"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
