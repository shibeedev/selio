const BULLETS: { tone: "danger" | "info" | "good" | "neutral"; who: string; text: string }[] = [
  { tone: "danger", who: "Stuck depositors", text: "sell their receipt and get paid now, instead of waiting for the pool to refill." },
  { tone: "info", who: "Borrowers", text: "repay their debt for less than face value, even with no cash on hand." },
  {
    tone: "good",
    who: "Everyone",
    text: "can deposit into the Selio Vault, which earns base yield while it waits, or place limit bids; when a pool freezes, that capital buys stuck receipts below face value and redeems them at full value when the pool refills.",
  },
  {
    tone: "neutral",
    who: "Depositors and curators",
    text: "see how much of each pool can still get out, so the risk is visible before a freeze.",
  },
];

export function Hero() {
  return (
    <section className="hero" aria-labelledby="h-hero">
      <div className="hero-main">
        <div className="eyebrow">Aave and Morpho on Monad</div>
        <h1 id="h-hero" className="hero-title">
          The exit market for frozen lending pools
        </h1>
        <ul className="hero-bullets">
          {BULLETS.map((b) => (
            <li key={b.who}>
              <span className={`bullet-dot bullet-dot--${b.tone}`} aria-hidden="true" />
              <span>
                <b>{b.who}</b> {b.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="hero-stats">
        <div className="hero-stat">
          <span className="hero-stat-value mono text-bad">100%</span>
          <span className="hero-stat-text">
            Utilization of Aave's USDT0 pool on Monad: 0 of about $123.7M supplied could be withdrawn, 7 Aug 2026, 21:30 UTC
          </span>
        </div>
        <div className="hero-stat">
          <span className="hero-stat-value mono text-warn">$9.99</span>
          <span className="hero-stat-text">
            Idle USDC in Hyperithm USDC Apex, a $51.14M Morpho vault on Monad with no liquidity adapter, 11 Oct 2026
          </span>
        </div>
      </div>
    </section>
  );
}
