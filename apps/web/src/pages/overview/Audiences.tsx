import { ArrowRight, PathIcon } from "../../components/Icons";
import { hrefFor, type Route } from "../../lib/router";

const AUDIENCES: { who: string; does: string; gets: string; cta: string; route: Route; tone: string; icon: string }[] = [
  {
    who: "Stuck depositors and loopers",
    does: "Sell the receipt your pool can't redeem: aMonUSDT0 on Aave, USDC vault shares on Morpho.",
    gets: "Paid now, at a bid or auction price, without waiting for a rescue coalition.",
    cta: "Sell a stuck position",
    route: "sell",
    tone: "danger",
    icon: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
  },
  {
    who: "Borrowers of the same asset",
    does: "Buy receipts below face value and repay your debt with them in one transaction, even with no cash on hand.",
    gets: "Repay for less, and your health factor only goes up.",
    cta: "Repay at a discount",
    route: "buy",
    tone: "info",
    icon: "M12 3v14M5 10l7 7 7-7M5 21h14",
  },
  {
    who: "Discount buyers",
    does: "Deposit into the Selio Vault, or place limit bids at your own discount.",
    gets: "Base yield while you wait. When a pool freezes, you buy receipts below face value and redeem them at full value once it refills. Withdraw or cancel anytime.",
    cta: "Start earning",
    route: "earn",
    tone: "good",
    icon: "M3 17l6-6 4 4 8-8M15 7h6v6",
  },
  {
    who: "Borrowers with frozen collateral",
    does: "Repay or swap collateral on Aave even when your collateral pool won't let you withdraw.",
    gets: "Keep managing your position in a freeze. Every route is simulated before you sign.",
    cta: "Manage frozen collateral",
    route: "frozen",
    tone: "warn",
    icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v4l3 2",
  },
];

export function Audiences() {
  return (
    <section className="stack" aria-labelledby="h-who">
      <h2 id="h-who" className="h2">
        Who Selio is for
      </h2>
      <div className="audiences">
        {AUDIENCES.map((a) => (
          <article key={a.route} className="audience card" data-testid={`audience-${a.route}`}>
            <div className="audience-head">
              <span className={`audience-icon audience-icon--${a.tone}`}>
                <PathIcon d={a.icon} />
              </span>
              <h3 className="h3">{a.who}</h3>
            </div>
            <div className="audience-body">
              <div>
                <span className="kicker">What you do</span>
                <span className="text-2">{a.does}</span>
              </div>
              <div>
                <span className="kicker">What you get</span>
                <span>{a.gets}</span>
              </div>
            </div>
            <a className="audience-cta" href={hrefFor(a.route)}>
              {a.cta}
              <ArrowRight size={16} />
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
