import type { SelioClient } from "@selio/sdk";
import { describeError } from "../lib/errors";
import { formatBps, formatToken } from "../lib/format";
import { useAsync } from "../lib/hooks";
import type { MarketMeta } from "../lib/market";
import { useNetwork } from "../lib/network-context";
import { Chip, Notice } from "./ui";

/**
 * Bid levels of the receipt's Kuru market, each as a discount below face value and the face value it buys. They are
 * not escrowed in Selio, so they never count in Selio's buying power or "Exit via vault & bids".
 */
export function KuruBook({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { refreshKey } = useNetwork();
  const U = meta.underlying;
  const book = useAsync(() => selio.kuruBook(), [selio], { pollMs: 15_000, reloadKey: refreshKey });
  const levels = (book.data ?? []).filter((l) => l.faceAssets > 0n);
  const total = levels.reduce((sum, l) => sum + l.faceAssets, 0n);
  return (
    <div className="stack-sm" data-testid="kuru-book">
      <div className="panel-head">
        <h3 className="h3">Kuru order book</h3>
        <Chip tone="neutral">Kuru</Chip>
      </div>
      <p className="small muted">
        Bids on Kuru's order book for the same receipt, read as a discount below face value. Sell now uses them where they pay you
        more than Selio's bids.
      </p>
      {book.error != null && <Notice tone="danger">Can't read the Kuru book: {describeError(book.error)}</Notice>}
      {!book.data && book.error == null && <p className="muted loading">Reading the Kuru book…</p>}
      {book.data && levels.length === 0 && <p className="muted">No Kuru bids yet.</p>}
      {levels.length > 0 && (
        <div className="book">
          <div className="book-row book-row--head">
            <span>Discount</span>
            <span className="right">Buys up to</span>
            <span className="right">Venue</span>
          </div>
          {levels.map((l) => (
            <div key={l.price} className="book-row" data-testid={`kuru-level-${l.price}`}>
              <span className="mono">{formatBps(l.discountBps)}</span>
              <span className="mono right">{formatToken(l.faceAssets, U)}</span>
              <span className="right">
                <Chip tone="neutral">Kuru</Chip>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="book-total">
        <span>Kuru depth</span>
        <span className="mono" data-testid="kuru-book-total">
          {formatToken(total, U)}
        </span>
      </div>
    </div>
  );
}
