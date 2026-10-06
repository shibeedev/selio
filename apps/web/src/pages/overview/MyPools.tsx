import type { SelioClient } from "@selio/sdk";
import { DemoFunds } from "../../components/DemoFunds";
import { Notice, StatusChip } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatBps, formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { poolSubtitle, poolTitle, receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { hrefFor } from "../../lib/router";
import { useWallet } from "../../lib/wallet-context";
import type { CapacityData } from "./CapacitySection";

/** "My pools": this pool, when the connected wallet holds its receipts. */
export function MyPools({ selio, meta, capacity }: { selio: SelioClient; meta: MarketMeta; capacity?: CapacityData }) {
  const { key, info, refreshKey } = useNetwork();
  const { address } = useWallet();
  const position = useAsync(() => selio.receiptValueOf(address!), [selio, address], {
    enabled: !!address,
    reloadKey: refreshKey,
  });

  if (!address) return <Notice tone="neutral">Connect a wallet to see the pools you have deposits in on {info.label}.</Notice>;
  if (position.error) return <Notice tone="danger">Can't read your deposits: {describeError(position.error)}</Notice>;
  if (position.data === undefined) return <p className="muted loading">Reading your deposits…</p>;
  if (position.data === 0n) {
    return (
      <div className="stack-sm" data-testid="my-pools-empty">
        <Notice tone="neutral">
          You have no deposit in {poolTitle(meta)} on {info.label}. Pools you supply to show up here with their exit capacity.
        </Notice>
        <DemoFunds kits={["seller"]} compact />
      </div>
    );
  }
  const util = capacity?.cap.utilizationBps;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Pool</th>
            <th scope="col">Your position</th>
            <th scope="col">Utilization</th>
            <th scope="col">Status</th>
            <th scope="col">Next step</th>
          </tr>
        </thead>
        <tbody>
          <tr data-testid={`my-pool-row-${key}`}>
            <td>
              <div className="cell-title">{poolTitle(meta)}</div>
              <div className="cell-sub">{poolSubtitle(meta)}</div>
            </td>
            <td className="mono" data-testid="my-pool-position">
              {formatToken(position.data, meta.underlying)} in {receiptNoun(meta)}
            </td>
            <td className="mono">{util === undefined ? "…" : formatBps(util)}</td>
            <td>{util === undefined ? "…" : <StatusChip utilizationBps={util} />}</td>
            <td>
              <a className="btn btn--primary btn--small" href={hrefFor("sell")} data-testid="my-pool-sell">
                Sell
              </a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
