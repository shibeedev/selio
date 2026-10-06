import { DeploymentGate } from "../../components/DeploymentGate";
import { Notice } from "../../components/ui";
import { useNetwork } from "../../lib/network-context";
import { hrefFor } from "../../lib/router";
import { FrozenRoute } from "./FrozenRoute";

export function FrozenPage() {
  const { info } = useNetwork();
  return (
    <div className="stack-lg">
      <section className="page-head" aria-labelledby="h-route">
        <h1 id="h-route">Frozen collateral</h1>
        <p className="lead">
          Need to repay or switch collateral while your collateral sits in a frozen Aave pool? Selio sells the collateral receipt
          instead of withdrawing it. Used only when a direct withdrawal fails, and always simulated before you sign.
        </p>
      </section>
      {info.venue === "morpho" ? (
        <section className="card card--pad stack narrow" aria-labelledby="h-rh" data-testid="frozen-not-needed">
          <h2 id="h-rh" className="h2">
            Not needed on {info.label}
          </h2>
          <p className="text-2 body-lg">
            Morpho keeps borrowers' collateral outside the lending pool. Withdrawing collateral only checks your health factor, never
            the market's liquidity, so collateral cannot get stuck when a USDC market is fully borrowed.
          </p>
          <p className="text-2 body-lg">Stuck on the lending side instead? USDC deposits and vault shares exit through a sale.</p>
          <a className="btn btn--primary btn--lg self-start" href={hrefFor("sell")}>
            Sell a stuck USDC position
          </a>
        </section>
      ) : (
        <DeploymentGate>
          {({ selio, meta }) =>
            selio.deployment.collateralRoute ? (
              <FrozenRoute selio={selio} meta={meta} route={selio.deployment.collateralRoute} />
            ) : (
              <Notice tone="neutral" testid="frozen-no-route">
                The frozen-collateral route is not deployed on {info.label} yet.
              </Notice>
            )
          }
        </DeploymentGate>
      )}
    </div>
  );
}
