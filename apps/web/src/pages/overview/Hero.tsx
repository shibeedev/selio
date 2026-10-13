import type { CSSProperties } from "react";

/** Who Selio serves: one numbered glass card each, rising in one after another. */
const AUDIENCES: { label: string; text: string }[] = [
  {
    label: "For lenders and loopers:",
    text: "exit in full, even beyond what the pool's utilization allows, by selling the rest of your receipt instantly into Selio's standing bids or through an auction.",
  },
  {
    label: "For borrowers:",
    text: "buy receipts on Selio at a discount to repay your debt, all in one transaction. No cash needed: with a flash loan, the seller is paid from the freed collateral.",
  },
  {
    label: "For borrowers whose collateral is stuck in a tight pool:",
    text: "a fallback route sells that collateral through Selio to repay debt or switch collateral.",
  },
  {
    label: "For everyone:",
    text: "deposit into the Selio Vault. When pool utilization is high, it buys receipts at a discount and later redeems them at full value, earning the gap. Funds waiting in the vault earn base yield automatically.",
  },
];

export function Hero() {
  return (
    <section className="hero" aria-labelledby="h-hero">
      <div className="eyebrow">Aave and Morpho on Monad</div>
      <h1 id="h-hero" className="hero-title">
        The exit market for{" "}
        <span className="hero-title-accent">
          <span className="nowrap">high-utilization</span> lending pools
        </span>
      </h1>
      <ul className="audiences" data-testid="hero-audiences">
        {AUDIENCES.map((a, i) => (
          <li key={a.label} className="audience" style={{ "--i": i } as CSSProperties}>
            <span className="audience-num" aria-hidden="true">
              {i + 1}
            </span>
            <p className="audience-text">
              <b>{a.label}</b> {a.text}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
