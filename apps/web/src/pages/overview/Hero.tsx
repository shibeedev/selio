import type { CSSProperties } from "react";
import { PathIcon } from "../../components/Icons";

/** Who Selio serves: one glass card each, rising in one after another. */
const AUDIENCES: { label: string; text: string; icon: string }[] = [
  {
    label: "For lenders and loopers:",
    text: "exit in full, even beyond what the pool's utilization allows, by selling the rest of your receipt instantly into Selio's standing bids or through an auction.",
    icon: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
  },
  {
    label: "For borrowers:",
    text: "buy receipts on Selio at a discount to repay your debt, all in one transaction. No cash needed: with a flash loan, the seller is paid from the freed collateral.",
    icon: "M12 3v14M5 10l7 7 7-7M5 21h14",
  },
  {
    label: "For borrowers whose collateral is stuck in a tight pool:",
    text: "a fallback route sells that collateral through Selio to repay debt or switch collateral.",
    icon: "M4 8h13l-4-4M20 16H7l4 4",
  },
  {
    label: "For everyone:",
    text: "deposit into the Selio Vault. When pool utilization is high, it buys receipts at a discount and later redeems them at full value, earning the gap. Funds waiting in the vault earn base yield automatically.",
    icon: "M3 17l6-6 4 4 8-8M15 7h6v6",
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
            <span className="audience-icon" aria-hidden="true">
              <PathIcon d={a.icon} size={20} />
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
