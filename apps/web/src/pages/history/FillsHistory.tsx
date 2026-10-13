import { useState } from "react";
import { isAddressEqual, type Address } from "viem";
import type { IndexedFill, IndexedFillKind, TokenInfo } from "@selio/sdk";
import { Notice, Stat } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { feeLabel, findToken } from "../../lib/fees";
import { formatBps, formatToken, shortAddress } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { HISTORY_POLL_MS, rangeSince } from "../../lib/indexer";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { explorerTxUrl } from "../../lib/networks";
import { useWallet } from "../../lib/wallet-context";
import { axisTime } from "./CapacityHistory";
import type { HistoryPanelProps } from "./HistoryPage";

const PAGE = 50;

const KIND: Record<IndexedFillKind, string> = {
  BORROWER_WALLET: "Borrower repaid · wallet",
  BORROWER_COLLATERAL: "Borrower repaid · flash",
  SELL_NOW: "Sell now",
  AUCTION_MATCH: "Auction match",
};


/** An amount of a pay token; a token outside the market's list shows its raw amount and short address. */
function payAmount(amount: bigint, token: Address, tokens: readonly TokenInfo[]): string {
  const info = findToken(tokens, token);
  return info ? formatToken(amount, info) : `${amount} of ${shortAddress(token)}`;
}

function perToken(entries: readonly { token: Address; amount: bigint }[], tokens: readonly TokenInfo[]): string {
  const shown = entries.filter((e) => e.amount > 0n);
  return shown.length === 0 ? "none" : shown.map((e) => payAmount(e.amount, e.token, tokens)).join(" + ");
}

function FillRow({ fill: f, you, meta: m }: { fill: IndexedFill; you: Address | null; meta: MarketMeta }) {
  const { info } = useNetwork();
  const who = (account: Address, vault = false) =>
    vault ? "Selio Vault" : you && isAddressEqual(account, you) ? "You" : shortAddress(account);
  const url = explorerTxUrl(info, f.txHash);
  return (
    <tr data-testid={`history-fill-row-${f.blockNumber}-${f.logIndex}`}>
      <td className="mono">{axisTime(f.timestamp)}</td>
      <td>{KIND[f.kind]}</td>
      <td className="mono">{who(f.seller)}</td>
      <td className="mono">{who(f.buyer, f.buyerIsSelioVault)}</td>
      <td className="mono">{formatToken(f.assets, m.underlying)}</td>
      <td className="mono">{payAmount(f.paid, f.payToken, m.payTokens)}</td>
      <td className="mono">{payAmount(f.fee, f.payToken, m.payTokens)}</td>
      <td className="mono">{payAmount(f.sellerNet, f.payToken, m.payTokens)}</td>
      <td className="mono">{formatBps(f.discountBps)}</td>
      <td className="mono">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {shortAddress(f.txHash)} ↗
          </a>
        ) : (
          <span title={f.txHash}>{shortAddress(f.txHash)}</span>
        )}
      </td>
    </tr>
  );
}

/** Every fill with the 0.2% fee and what the seller got, and the fees collected per pay token. */
export function FillsHistory({ client, selio, meta, range, mine }: HistoryPanelProps) {
  const { refreshKey } = useNetwork();
  const { address } = useWallet();
  const [pages, setPages] = useState(1);
  const read = useAsync(
    () =>
      client.fills(selio.market, {
        since: rangeSince(range, Math.floor(Date.now() / 1000)),
        account: mine ?? undefined,
        limit: PAGE * pages,
      }),
    [client, selio, range, mine, pages],
    { pollMs: HISTORY_POLL_MS, reloadKey: refreshKey },
  );

  let body;
  if (read.error != null && !read.data) {
    body = <Notice tone="danger">Can't read fills from the index: {describeError(read.error)}</Notice>;
  } else if (!read.data) {
    body = <p className="muted loading">Reading fills…</p>;
  } else {
    const { fills, fees } = read.data;
    body = (
      <>
        {fills.length === 0 ? (
          <p className="muted">{mine ? "You sold or bought nothing in this range." : "No fill in this range."}</p>
        ) : (
          <div className="table-wrap">
            <table className="data data--wide" data-testid="history-fills">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Seller</th>
                  <th scope="col">Buyer</th>
                  <th scope="col">Receipt value</th>
                  <th scope="col">Paid</th>
                  <th scope="col">{feeLabel(meta.feeBps)}</th>
                  <th scope="col">Seller got</th>
                  <th scope="col">Discount</th>
                  <th scope="col">Tx</th>
                </tr>
              </thead>
              <tbody>
                {fills.map((f) => (
                  <FillRow key={`${f.blockNumber}-${f.logIndex}`} fill={f} you={address} meta={meta} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {fills.length === PAGE * pages && (
          <button
            type="button"
            className="btn btn--secondary btn--small self-start"
            onClick={() => setPages((p) => p + 1)}
            data-testid="history-more-fills"
          >
            Show more
          </button>
        )}
        <p className="small" data-testid="history-fees">
          Fees collected: {perToken(fees.map((t) => ({ token: t.payToken, amount: t.fees })), meta.payTokens)}
        </p>
      </>
    );
  }

  return (
    <section className="card card--pad stack" aria-labelledby="h-history-fills">
      <h2 id="h-history-fills" className="h2-sm">
        Fills
      </h2>
      {body}
    </section>
  );
}

/** With "Mine": the connected wallet's totals on this market, from the index. */
export function WalletHistory({ client, selio, meta, mine }: HistoryPanelProps) {
  const { refreshKey } = useNetwork();
  const U = meta.underlying;
  const read = useAsync(() => client.wallet(selio.market, mine as Address), [client, selio, mine], {
    enabled: mine !== null,
    pollMs: HISTORY_POLL_MS,
    reloadKey: refreshKey,
  });
  if (!mine) return null;
  const a = read.data?.account;
  return (
    <section className="card card--pad stack" aria-labelledby="h-history-wallet" data-testid="history-wallet">
      <h2 id="h-history-wallet" className="h2-sm">
        Your wallet on this market
      </h2>
      {read.error != null && !read.data ? (
        <Notice tone="danger">Can't read your totals from the index: {describeError(read.error)}</Notice>
      ) : !read.data ? (
        <p className="muted loading">Reading your totals…</p>
      ) : !a ? (
        <p className="muted">The index has seen no activity of {shortAddress(mine)} on this market yet.</p>
      ) : (
        <div className="stats">
          <Stat label="Sold" value={formatToken(a.soldAssets, U)} />
          <Stat label="Received after fees" value={perToken(a.tokens.map((t) => ({ token: t.token, amount: t.receivedNet })), meta.payTokens)} />
          <Stat label="Fees paid" value={perToken(a.tokens.map((t) => ({ token: t.token, amount: t.feesPaid })), meta.payTokens)} />
          <Stat label="Bought" value={formatToken(a.boughtAssets, U)} />
          <Stat label="Debt repaid" value={formatToken(a.debtRepaid, U)} />
          <Stat label="Bids placed" value={String(a.bidsPlaced)} />
          <Stat label="Receipt shares" value={formatToken(a.receiptShares, meta.receipt)} />
          <Stat label="Vault shares" value={formatToken(a.vaultShares, { decimals: meta.vault.decimals, symbol: meta.vault.symbol })} />
        </div>
      )}
    </section>
  );
}
