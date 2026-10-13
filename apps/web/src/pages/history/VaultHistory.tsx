import { zeroAddress } from "viem";
import { selioVaultAbi, type IndexedVaultAction, type IndexedVaultActionKind, type TokenInfo } from "@selio/sdk";
import { Notice, Stat } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatToken, shortAddress } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { filledBuckets, HISTORY_POLL_MS, HISTORY_RANGES, rangeSince } from "../../lib/indexer";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { explorerTxUrl } from "../../lib/networks";
import { AmountChart, type ChartLine } from "./CapacityHistory";
import type { HistoryPanelProps } from "./HistoryPage";

export const VAULT_ACTION_LABEL: Record<IndexedVaultActionKind, string> = {
  DEPOSIT: "Deposit",
  REDEEM: "Withdrawal",
  RECOVER: "Recovered receipts",
  DEFER: "Receipt skipped, claimable later",
  CLAIM: "Skipped receipt claimed",
  SOURCE_DEPOSIT: "Moved to yield source",
  SOURCE_WITHDRAW: "Taken from yield source",
  SOURCE_PULL: "Pulled back from yield source",
  SOURCE_IN_KIND: "Paid in source shares",
};

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function actionAmount(a: IndexedVaultAction, meta: MarketMeta, source: TokenInfo | null): string | null {
  const U = meta.underlying;
  if (a.kind === "SOURCE_IN_KIND") return a.shares === null ? null : source ? formatToken(a.shares, source) : `${a.shares} source shares`;
  if (a.kind === "DEFER" || a.kind === "CLAIM") return a.receiptUnits === null ? null : formatToken(a.receiptUnits, meta.receipt);
  const assets = a.assets === null ? null : formatToken(a.assets, U);
  if (a.kind === "REDEEM" && a.receiptUnits !== null && a.receiptUnits > 0n) {
    return `${assets ?? "0"} + ${formatToken(a.receiptUnits, meta.receipt)} in kind`;
  }
  if (a.kind === "SOURCE_PULL" && a.utilizationBps !== null) return `${assets ?? "—"} at ${formatBps(a.utilizationBps)} source utilization`;
  return assets;
}

type Point = { t: number; value: bigint };

/** What the Selio Vault bought, recovered and is worth per share, and its latest actions. */
export function VaultHistory({ client, selio, meta, range }: HistoryPanelProps) {
  const { info, refreshKey } = useNetwork();
  const U = meta.underlying;
  const { interval } = HISTORY_RANGES[range];
  const read = useAsync(
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const since = rangeSince(range, now);
      const r = await client.vault(selio.market, meta.vault.address, { interval, since });
      return { ...r, buckets: filledBuckets(null, r.points, since, now, interval) };
    },
    [client, selio, meta, range],
    { pollMs: HISTORY_POLL_MS, reloadKey: refreshKey },
  );
  // Source shares paid in kind are shown in the yield source's own token.
  const source = useAsync(
    async () => {
      const ys = await selio.client.readContract({ address: meta.vault.address, abi: selioVaultAbi, functionName: "yieldSource" });
      return ys === zeroAddress ? null : selio.token(ys);
    },
    [selio, meta],
  );

  const shareValue: ChartLine<Point>[] = [
    { key: "share", label: `${U.symbol} per ${meta.vault.symbol}`, color: "var(--purple-300)", value: (p) => p.value },
  ];

  let body;
  if (read.error != null && !read.data) {
    body = <Notice tone="danger">Can't read the Selio Vault's history from the index: {describeError(read.error)}</Notice>;
  } else if (!read.data) {
    body = <p className="muted loading">Reading the Selio Vault's history…</p>;
  } else if (!read.data.state) {
    body = <p className="muted">The Selio Vault has no activity yet.</p>;
  } else {
    const { state: v, buckets, actions } = read.data;
    const points: Point[] = buckets.map((b) => ({ t: b.start, value: b.point.assetsPerShare }));
    body = (
      <>
        <div className="stats">
          <Stat
            label="Bought"
            value={`${formatToken(v.boughtAssets, U)} of receipts`}
            sub={`for ${formatToken(v.boughtCost, U)} in ${v.boughtFills} fills`}
          />
          <Stat label="Recovered" value={formatToken(v.recoveredAssets, U)} />
          <Stat label="Recovery rate" value={v.recoveryRateBps === null ? "—" : formatBps(v.recoveryRateBps)} sub="of the face value bought" />
          <Stat label="Cost recovered" value={v.costRecoveryBps === null ? "—" : formatBps(v.costRecoveryBps)} sub="of what the vault paid" />
        </div>
        <div className="panel">
          <h3 className="h3">Share value over time</h3>
          {points.length === 0 ? (
            <p className="muted">No vault activity in this range.</p>
          ) : (
            <AmountChart
              points={points}
              lines={shareValue}
              decimals={U.decimals}
              fromData
              maxDecimals={6}
              label="Selio Vault share value over time"
              testid="history-share-value-chart"
            />
          )}
        </div>
        {actions.length === 0 ? (
          <p className="muted">No vault actions yet.</p>
        ) : (
          <ul className="alert-list" aria-label="Latest Selio Vault actions">
            {actions.map((a) => {
              const amount = actionAmount(a, meta, source.data ?? null);
              const url = explorerTxUrl(info, a.txHash);
              return (
                <li key={`${a.blockNumber}-${a.logIndex}`}>
                  <span className="small">
                    {when(a.timestamp)} · <b>{VAULT_ACTION_LABEL[a.kind]}</b>
                    {amount && (
                      <>
                        {" "}
                        · <span className="mono">{amount}</span>
                      </>
                    )}
                  </span>
                  <span className="small mono">
                    {url ? (
                      <a href={url} target="_blank" rel="noreferrer">
                        {shortAddress(a.txHash)} ↗
                      </a>
                    ) : (
                      <span title={a.txHash}>{shortAddress(a.txHash)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="card card--pad stack" aria-labelledby="h-history-vault" data-testid="history-vault">
      <h2 id="h-history-vault" className="h2-sm">
        Selio Vault
      </h2>
      {body}
    </section>
  );
}
