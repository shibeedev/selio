import { useState } from "react";
import type { Address } from "viem";
import type { IndexerClient, SelioClient } from "@selio/sdk";
import { DeploymentGate } from "../../components/DeploymentGate";
import { Notice, ToggleGroup } from "../../components/ui";
import { shortAddress } from "../../lib/format";
import { HISTORY_RANGES, useIndexer, useIndexerStatus, type HistoryRange, type IndexerStatusView } from "../../lib/indexer";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { hrefFor } from "../../lib/router";
import { useWallet } from "../../lib/wallet-context";
import { AuctionsHistory } from "./AuctionsHistory";
import { CapacityHistory } from "./CapacityHistory";
import { FillsHistory, WalletHistory } from "./FillsHistory";
import { VaultHistory } from "./VaultHistory";

export interface HistoryPanelProps {
  client: IndexerClient;
  selio: SelioClient;
  meta: MarketMeta;
  range: HistoryRange;
  /** The connected wallet while "Mine" is on. */
  mine: Address | null;
}

const OFF_TEXT =
  "History is not available on this deployment yet. Market history needs the Selio indexer, which this build does not point to. Current market data on the other pages is read from the chain.";

/** The status line of every state but the fork note: how far the index has reached, or why there is no history. */
function HistoryStatus({ view, market }: { view: IndexerStatusView; market: Address | null }) {
  const { info } = useNetwork();
  const { state, status, head, error } = view;
  if (state === null) {
    return (
      <p className="small muted loading" data-testid="history-status" data-state="loading">
        Reading the Selio indexer…
      </p>
    );
  }
  if (state === "ready" && status) {
    return (
      <p className="small muted" data-testid="history-status" data-state="ready">
        Indexed with Envio to block {status.progressBlock.toLocaleString("en-US")}.
      </p>
    );
  }
  let tone: "neutral" | "warn" | "danger" = "neutral";
  let text = OFF_TEXT;
  if (state === "unavailable") {
    tone = "danger";
    text = `Market history is unavailable: ${error ?? "no answer"} Current market data on the other pages is read from the chain and is not affected.`;
  } else if (state === "not-indexed") {
    text = `The Selio indexer does not cover this market (${market ? shortAddress(market) : "—"}) yet, so there is no history to show.`;
  } else if (state === "syncing" && status) {
    tone = "warn";
    const of = head ?? (status.sourceBlock !== null ? BigInt(status.sourceBlock) : null);
    text = `The Selio indexer is still catching up with ${info.label} (block ${status.progressBlock.toLocaleString("en-US")}${of !== null ? ` of ${of.toLocaleString("en-US")}` : ""}). History below is incomplete.`;
  } else if (state === "lagging" && status && head !== null) {
    tone = "warn";
    const lag = head - BigInt(status.progressBlock);
    text = `History is indexed to block ${status.progressBlock.toLocaleString("en-US")}, ${lag.toLocaleString("en-US")} blocks behind the chain. Newer activity appears shortly.`;
  }
  return (
    <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : "status"} data-testid="history-status" data-state={state}>
      {text}
    </div>
  );
}

function HistoryBody({ client, selio, meta, view }: { client: IndexerClient; selio: SelioClient; meta: MarketMeta; view: IndexerStatusView }) {
  const wallet = useWallet();
  const [range, setRange] = useState<HistoryRange>("7d");
  const [mineOn, setMineOn] = useState(false);
  const mine = mineOn && wallet.address ? wallet.address : null;
  const rows = view.state === "ready" || view.state === "lagging" || view.state === "syncing";
  const props: HistoryPanelProps = { client, selio, meta, range, mine };
  return (
    <>
      <HistoryStatus view={view} market={selio.market} />
      {rows && (
        <>
          <div className="section-head">
            <ToggleGroup<HistoryRange>
              variant="tab"
              label="Time range"
              value={range}
              onChange={setRange}
              options={(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((r) => ({
                value: r,
                label: HISTORY_RANGES[r].label,
                testid: `history-range-${r}`,
              }))}
            />
            <div className="toggle-group" role="group" aria-label="Filter">
              <button
                type="button"
                className="toggle toggle--pill"
                aria-pressed={mine !== null}
                disabled={!wallet.address}
                title={wallet.address ? "Only auctions you opened and fills you sold or bought" : "Connect a wallet to filter by it"}
                onClick={() => setMineOn((on) => !on)}
                data-testid="history-mine"
              >
                Mine
              </button>
            </div>
          </div>
          <CapacityHistory {...props} />
          {mine && <WalletHistory {...props} />}
          <AuctionsHistory {...props} />
          <FillsHistory {...props} />
          <VaultHistory {...props} />
        </>
      )}
    </>
  );
}

/** Market history from the Selio event index (Monad Testnet); display only, so every page's current data stays on-chain. */
export function HistoryPage() {
  const client = useIndexer();
  const view = useIndexerStatus();
  const head = (
    <section className="page-head" aria-labelledby="h-history">
      <h1 id="h-history">Market history</h1>
      <p className="lead">
        What happened on this market since it launched: auctions and their discounts, every fill and its fee, the bid book over
        time, and what the Selio Vault recovered. Indexed with Envio; for display only, since prices, capacity and every
        transaction are always read from the chain.
      </p>
    </section>
  );
  if (view.state === "fork") {
    return (
      <div className="stack-lg">
        {head}
        <Notice tone="neutral" testid="history-fork-note">
          Market history is indexed on Monad Testnet only. This scenario fork is re-created every day, so its history is not kept.
          Your sales and bids on this fork are listed on <a href={hrefFor("sell")}>Sell</a> and <a href={hrefFor("earn")}>Earn</a>.
        </Notice>
      </div>
    );
  }
  if (view.state === "off" || !client) {
    return (
      <div className="stack-lg">
        {head}
        <HistoryStatus view={{ ...view, state: "off" }} market={null} />
      </div>
    );
  }
  return (
    <div className="stack-lg">
      {head}
      <DeploymentGate>{({ selio, meta }) => <HistoryBody client={client} selio={selio} meta={meta} view={view} />}</DeploymentGate>
    </div>
  );
}
