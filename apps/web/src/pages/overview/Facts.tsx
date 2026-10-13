export function Facts() {
  return (
    <section className="stack" aria-labelledby="h-facts">
      <h2 id="h-facts" className="h2">
        Facts
      </h2>
      <div className="facts">
        <div className="fact">
          <span className="fact-value mono text-bad">100%</span>
          <span className="fact-text">
            Utilization of Aave's USDT0 pool on Monad: 0 of about $123.7M supplied could be withdrawn, 7 Aug 2026, 21:30 UTC
          </span>
        </div>
        <div className="fact">
          <span className="fact-value mono text-warn">$9.99</span>
          <span className="fact-text">
            Idle USDC in Hyperithm USDC Apex, a $51.14M Morpho vault on Monad with no liquidity adapter, 11 Oct 2026
          </span>
        </div>
      </div>
    </section>
  );
}
