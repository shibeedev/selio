import { Notice, StatusChip, UtilBar } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatToken } from "../../lib/format";
import type { AsyncState } from "../../lib/hooks";
import { poolSubtitle, poolTitle, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { hrefFor } from "../../lib/router";
import type { CapacityData } from "./CapacitySection";

/** "All pools": the selected network's single pool. */
export function CapacityTable({ meta, capacity }: { meta: MarketMeta; capacity: AsyncState<CapacityData> }) {
  const { key } = useNetwork();
  const U = meta.underlying;
  const data = capacity.data;
  if (!data) {
    return capacity.error ? (
      <Notice tone="danger" testid="capacity-error">
        Can't read exit capacity: {describeError(capacity.error)}
      </Notice>
    ) : (
      <p className="muted loading">Reading exit capacity…</p>
    );
  }
  const { cap, bidTotal, levels } = data;
  return (
    <div className="stack-sm">
      <div className="table-wrap">
        <table className="data data--wide">
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col">Withdrawable now</th>
              <th scope="col">Utilization</th>
              <th scope="col">Exit via borrowers</th>
              <th scope="col">Exit via vault &amp; bids</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid={`capacity-row-${key}`}>
              <td>
                <div className="cell-title">{poolTitle(meta)}</div>
                <div className="cell-sub">
                  {poolSubtitle(meta)} · supplied <span data-testid="capacity-supplied">{formatToken(cap.supplied, U)}</span>
                </div>
              </td>
              <td className="mono" data-testid="capacity-withdrawable">
                {formatToken(cap.withdrawable, U)}
              </td>
              <td>
                <UtilBar utilizationBps={cap.utilizationBps} testid="capacity-utilization" />
              </td>
              <td className="mono text-good" data-testid="capacity-borrowers">
                {formatToken(cap.debtorCapacity, U)}
              </td>
              <td className="mono text-good">
                <span data-testid="capacity-bids">{formatToken(bidTotal, U)}</span>
                {levels.length > 0 && (
                  <span className="cell-sub levels">
                    {levels.slice(0, 3).map((level) => (
                      <span key={level.discountBps}>
                        at ≤ {formatBps(level.discountBps)}: {formatToken(level.cumulative, U)}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td>
                <StatusChip utilizationBps={cap.utilizationBps} testid="capacity-status" />
              </td>
              <td>
                <div className="row-sm">
                  <a className="btn btn--primary btn--small" href={hrefFor("sell")} data-testid="capacity-action-sell">
                    Sell
                  </a>
                  <a className="btn btn--secondary btn--small" href={hrefFor("buy")} data-testid="capacity-action-buy">
                    Buy &amp; repay
                  </a>
                  <a className="btn btn--secondary btn--small" href={hrefFor("earn")} data-testid="capacity-action-earn">
                    Earn
                  </a>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="legend">
        <b>Withdrawable now</b>: what the pool can pay out today. <b>Exit via borrowers</b>: same-asset debt whose holders can
        buy receipts to repay it. <b>Exit via vault &amp; bids</b>: receipts that escrowed limit bids and the Selio Vault can
        buy, counting escrowed funds only. Status: Frozen from 99% utilization, Tight from 90%.
        {cap.sessionAssets > 0n && ` Receipts waiting in open auctions: ${formatToken(cap.sessionAssets, U)}.`}
      </p>
    </div>
  );
}
