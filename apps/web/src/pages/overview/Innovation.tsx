import { useState } from "react";
import { ChevronDown, PathIcon } from "../../components/Icons";

/** Each item shows its title; the rest of its sentence opens on click. */
const ITEMS: { title: string; rest: string; icon: string }[] = [
  {
    title: "A brand-new market around lending pools",
    rest: "that connects lenders, borrowers and people looking for new ways to earn yield, keeping capital in tight pools moving and creating new demand and steady on-chain activity.",
    icon: "M3 12h4l3-8 4 16 3-8h4",
  },
  {
    title: "A fallback exit layer for lending pools",
    rest: "that lets lenders exit in full even at high utilization, without anyone adding new liquidity. Escrowed limit bids and the Selio Vault are on-chain before the crisis, so sellers get paid from the first block of a freeze.",
    icon: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  },
  {
    title: "The pool is not drained.",
    rest: "The pool's withdrawable liquidity is the same before and after every buyback, so one seller's exit never takes another lender's exit.",
    icon: "M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11zM9 14h6",
  },
  {
    title: "A new source of yield",
    rest: "that pays most when lending markets are under stress: the Selio Vault earns base yield while it waits, then buys receipts at a discount in tight pools and keeps their pool interest until it redeems them at full value.",
    icon: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  },
  {
    title: "Repay debt with an empty wallet.",
    rest: "With a flash loan, Selio repays the borrower's debt first and pays the seller from the collateral that repayment frees: no cash up front, no swaps, and the loan only gets safer.",
    icon: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  },
];

export function Innovation() {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });

  return (
    <section className="stack" aria-labelledby="h-innovation">
      <h2 id="h-innovation" className="h2">
        Our innovation
      </h2>
      <ul className="innovations">
        {ITEMS.map((item, i) => {
          const isOpen = open.has(i);
          return (
            <li key={item.title} className={isOpen ? "innovation is-open" : "innovation"}>
              <h3 className="innovation-head">
                <button
                  type="button"
                  id={`innovation-btn-${i}`}
                  className="innovation-toggle"
                  aria-expanded={isOpen}
                  aria-controls={`innovation-panel-${i}`}
                  data-testid={`innovation-toggle-${i}`}
                  onClick={() => toggle(i)}
                >
                  <span className="innovation-icon" aria-hidden="true">
                    <PathIcon d={item.icon} size={20} />
                  </span>
                  <span className="innovation-title">{item.title}</span>
                  <ChevronDown size={18} className="innovation-chevron" />
                </button>
              </h3>
              <div id={`innovation-panel-${i}`} role="region" aria-labelledby={`innovation-btn-${i}`} className="innovation-panel">
                <div className="innovation-panel-inner">
                  <p>{item.rest}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
