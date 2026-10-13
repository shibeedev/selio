import type { BidView, SelioClient } from "@selio/sdk";
import { KuruBook } from "../../components/KuruBook";
import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { findToken } from "../../lib/fees";
import { formatBps, formatToken } from "../../lib/format";
import type { AsyncState } from "../../lib/hooks";
import { hasKuru } from "../../lib/kuru";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { BID_OWNER_LABEL, bidOwner } from "../../lib/orderbook";
import { useWallet } from "../../lib/wallet-context";

/** The public book of escrowed bids, smallest discount first, and the receipt's Kuru book on a Kuru network. */
export function OrderBook({ selio, meta, book }: { selio: SelioClient; meta: MarketMeta; book: AsyncState<BidView[]> }) {
  const { address } = useWallet();
  const U = meta.underlying;
  const rows = (book.data ?? []).filter((b) => b.capacityAssets > 0n);
  const total = rows.reduce((sum, b) => sum + b.capacityAssets, 0n);
  return (
    <aside className="card card--pad stack-sm col-narrow" aria-labelledby="h-book" data-testid="orderbook">
      <h2 id="h-book" className="h2-sm">
        Bids · {receiptNoun(meta)}
      </h2>
      <p className="small muted">Every bid is escrowed, so a seller knows it will pay. Sellers fill from the smallest discount first.</p>
      {book.error != null && <Notice tone="danger">Can't read bids: {describeError(book.error)}</Notice>}
      {!book.data && book.error == null && <p className="muted loading">Reading bids…</p>}
      {book.data && rows.length === 0 && <p className="muted">No bids yet. Be the first buyer sellers can count on.</p>}
      {rows.length > 0 && (
        <div className="book">
          <div className="book-row book-row--head">
            <span>Discount</span>
            <span className="right">Buys up to</span>
            <span className="right">Bidder</span>
          </div>
          {rows.map((b) => {
            const owner = bidOwner(b.bidder, meta.vault.address, address);
            const payToken = findToken(meta.payTokens, b.payToken);
            return (
              <div key={String(b.id)} className="book-row" data-testid={`orderbook-row-${b.id}`} data-owner={owner}>
                <span className="mono">≥ {formatBps(b.minDiscountBps)}</span>
                <span className="mono right" title={payToken ? `Escrowed ${formatToken(b.escrow, payToken)}` : undefined}>
                  {formatToken(b.capacityAssets, U)}
                </span>
                <span className={`who who--${owner}`}>{BID_OWNER_LABEL[owner]}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="book-total">
        <span>Total buying power</span>
        <span className="mono" data-testid="orderbook-total">
          {formatToken(total, U)}
        </span>
      </div>
      {hasKuru(selio) && <KuruBook selio={selio} meta={meta} />}
    </aside>
  );
}
