import { ArrowRight, FlowArrow, Lock, LogoMark } from "../../components/Icons";
import { useNetwork } from "../../lib/network-context";

const BUYERS = [
  {
    title: "Borrowers of the same asset",
    text: "Use the receipt to repay their debt for less than face value, paying from their wallet or with a flash loan.",
  },
  {
    title: "Selio Vault",
    text: "Depositors' capital waits outside the pool, buys stuck receipts at a set discount, and redeems them at full value when the pool refills.",
  },
  {
    title: "Limit bids",
    text: "Buyers who want a discount set their price in advance; a bid fills when a sale reaches it.",
  },
];

export function HowItWorks() {
  const { meta } = useNetwork();
  const payList = meta.data ? meta.data.payTokens.map((t) => t.symbol).join(", ") : "AUSD, USDC, USDT0, WETH";
  return (
    <section className="card card--lg stack-lg" aria-labelledby="h-how">
      <h2 id="h-how" className="h2">
        How Selio works
      </h2>
      <div className="how-flow">
        <div className="how-card how-card--seller">
          <span className="how-icon">
            <Lock size={22} />
          </span>
          <span className="how-title">Stuck depositor</span>
          <span className="how-text">Holds aMonUSDT0 or USDC vault shares the pool can't pay out.</span>
        </div>
        <div className="how-arrow">
          <FlowArrow />
          <span>sells receipt</span>
        </div>
        <div className="how-card how-card--market">
          <span className="how-icon how-icon--market">
            <LogoMark size={22} />
          </span>
          <span className="how-title">Selio market</span>
          <span className="how-text">
            Sell now to the best limit bid or the Selio Vault, or run an auction whose discount rises until someone buys. Every
            sale settles in one transaction.
          </span>
        </div>
        <div className="how-arrow">
          <FlowArrow />
          <span>best price first</span>
        </div>
        <div className="how-buyers">
          {BUYERS.map((b) => (
            <div key={b.title} className="how-buyer">
              <span className="how-buyer-title">{b.title}</span>
              <span className="how-buyer-text">{b.text}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="notice notice--success how-paid">
        <ArrowRight size={20} />
        <span>
          <b>The seller is paid in the same transaction:</b> {payList}
          {meta.data && " on this network,"} or the buyer's freed collateral. The pool's withdrawable liquidity stays the same,
          so nobody else's exit gets smaller.
        </span>
      </div>
    </section>
  );
}
