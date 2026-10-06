import { DeploymentGate } from "../../components/DeploymentGate";
import { SellForm } from "./SellForm";
import { YourSales } from "./YourSales";

export function SellPage() {
  return (
    <div className="stack-lg">
      <section className="page-head" aria-labelledby="h-sell">
        <h1 id="h-sell">Sell a stuck position</h1>
        <p className="lead">
          The pool can't pay you out, so sell your stuck position on Selio and get paid now instead of waiting for the pool to
          refill.
        </p>
      </section>
      <DeploymentGate>
        {({ selio, meta }) => (
          <>
            <SellForm selio={selio} meta={meta} />
            <YourSales selio={selio} meta={meta} />
          </>
        )}
      </DeploymentGate>
    </div>
  );
}
