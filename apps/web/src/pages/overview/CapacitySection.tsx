import { useState } from "react";
import type { CapacityView } from "@selio/sdk";
import { DeploymentGate } from "../../components/DeploymentGate";
import { ToggleGroup } from "../../components/ui";
import { parsePercentToBps } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useNetwork } from "../../lib/network-context";
import { bidLevels, type BidLevel } from "../../lib/orderbook";
import { AgentPanel } from "./AgentPanel";
import { AlertForm } from "./AlertForm";
import { CapacityTable } from "./CapacityTable";
import { MyPools } from "./MyPools";
import { UtilizationChart } from "./UtilizationChart";

export interface CapacityData {
  cap: CapacityView;
  bidTotal: bigint;
  levels: BidLevel[];
}

type View = "all" | "mine";

export function CapacitySection() {
  const { info, selio, meta, refreshKey } = useNetwork();
  const [view, setView] = useState<View>("all");
  const [threshold, setThreshold] = useState("95");
  const metaData = meta.data;

  const capacity = useAsync<CapacityData>(
    async () => {
      if (!selio || !metaData) throw new Error("not ready");
      const [cap, bidTotal, bids] = await Promise.all([
        selio.capacity(),
        selio.bidCapacityAt(metaData.maxDiscountBps),
        selio.bids(),
      ]);
      return { cap, bidTotal, levels: bidLevels(bids) };
    },
    [selio, metaData],
    { enabled: !!selio && !!metaData, pollMs: 15_000, reloadKey: refreshKey },
  );

  const thresholdBps = parsePercentToBps(threshold) ?? undefined;

  return (
    <section id="capacity" className="card card--lg stack" aria-labelledby="h-pools">
      <div className="section-head">
        <div className="stack-xs">
          <h2 id="h-pools" className="h2">
            Exit capacity on {info.label}
          </h2>
          <p className="muted small">
            How much can leave each pool right now, and who stands ready to buy the rest. Read from the chain.
          </p>
        </div>
        <ToggleGroup<View>
          variant="tab"
          label="Pools view"
          value={view}
          onChange={setView}
          options={[
            { value: "all", label: "All pools", testid: "capacity-tab-all" },
            { value: "mine", label: "My pools", testid: "capacity-tab-mine" },
          ]}
        />
      </div>
      <DeploymentGate>
        {({ selio: client, meta: m }) => (
          <>
            {view === "all" ? (
              <CapacityTable meta={m} capacity={capacity} />
            ) : (
              <MyPools selio={client} meta={m} capacity={capacity.data} />
            )}
            <div className="split">
              <div className="panel chart-panel">
                <UtilizationChart meta={m} currentBps={capacity.data?.cap.utilizationBps} thresholdBps={thresholdBps} />
              </div>
              <AlertForm threshold={threshold} onThreshold={setThreshold} />
            </div>
            <AgentPanel selio={client} meta={m} />
          </>
        )}
      </DeploymentGate>
    </section>
  );
}
