import { useState } from "react";
import type { SelioClient } from "@selio/sdk";
import { DeploymentGate } from "../../components/DeploymentGate";
import { ToggleGroup } from "../../components/ui";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { LimitBidsSection } from "./LimitBidsSection";
import { OrderBook } from "./OrderBook";
import { VaultSection } from "./VaultSection";

type Tab = "vault" | "bids";

export function EarnPage() {
  return (
    <div className="stack-lg">
      <section className="page-head" aria-labelledby="h-earn">
        <h1 id="h-earn">Earn from frozen pools</h1>
        <p className="lead">
          Your capital earns base yield while it waits. When a pool freezes, it buys stuck receipts below face value and redeems
          them at full value once the pool refills. Use the shared Selio Vault, or set your own limit bids.
        </p>
      </section>
      <DeploymentGate>{({ selio, meta }) => <EarnBody selio={selio} meta={meta} />}</DeploymentGate>
    </div>
  );
}

function EarnBody({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { refreshKey } = useNetwork();
  const [tab, setTab] = useState<Tab>("vault");
  // One bid book for the vault, the limit bids and the public book.
  const book = useAsync(() => selio.bids(), [selio], { pollMs: 15_000, reloadKey: refreshKey });
  return (
    <div className="stack">
      <ToggleGroup<Tab>
        variant="tab"
        label="Ways to earn"
        value={tab}
        onChange={setTab}
        options={[
          { value: "vault", label: "Selio Vault", testid: "earn-tab-vault" },
          { value: "bids", label: "Limit bids", testid: "earn-tab-bids" },
        ]}
      />
      <div className="split split--top">
        <div className="col-wide stack">
          {tab === "vault" ? (
            <VaultSection selio={selio} meta={meta} bids={book.data} />
          ) : (
            <LimitBidsSection selio={selio} meta={meta} bids={book.data} />
          )}
        </div>
        <OrderBook meta={meta} book={book} />
      </div>
    </div>
  );
}
