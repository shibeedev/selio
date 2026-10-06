import { useState } from "react";
import { requestDemoFunds, type FaucetKit } from "../lib/api";
import { describeError } from "../lib/errors";
import { receiptNoun } from "../lib/market";
import { useNetwork } from "../lib/network-context";
import { useWallet } from "../lib/wallet-context";

const TITLE: Record<FaucetKit, string> = { seller: "Seller kit", borrower: "Borrower kit", bidder: "Bidder kit" };

/** Fork-only faucet: one click gives a ready-made position to try a flow with. */
export function DemoFunds({ kits, compact = false }: { kits: FaucetKit[]; compact?: boolean }) {
  const { key, info, meta, refresh } = useNetwork();
  const { address } = useWallet();
  const [busy, setBusy] = useState<FaucetKit | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!info.isFork || !address) return null;

  const m = meta.data;
  const purpose: Record<FaucetKit, string> = m
    ? {
        seller: `${receiptNoun(m)} stuck in the frozen pool, to try selling`,
        borrower: `a ${m.underlying.symbol} debt with collateral, to try repaying at a discount`,
        bidder: `${m.payTokens.map((t) => t.symbol).join(", ")}, to try limit bids and the Selio Vault`,
      }
    : {
        seller: "stuck receipts, to try selling",
        borrower: "a debt, to try repaying at a discount",
        bidder: "payment tokens, to try bids and the vault",
      };

  const request = async (kit: FaucetKit) => {
    setBusy(kit);
    setResult(null);
    try {
      const actions = await requestDemoFunds(key, address, kit);
      const steps = actions.length ? ` in ${actions.length} step${actions.length > 1 ? "s" : ""}` : "";
      setResult({ ok: true, text: `${TITLE[kit]} sent${steps}.` });
      refresh();
    } catch (e) {
      setResult({ ok: false, text: describeError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={compact ? "demo-funds demo-funds--compact" : "demo-funds"} data-testid="demo-funds">
      {!compact && <p className="small muted">Get demo funds on this fork, so you can try each flow without real assets.</p>}
      <div className="demo-kits">
        {kits.map((kit) => (
          <button
            key={kit}
            type="button"
            className="btn btn--secondary btn--small demo-kit"
            disabled={busy !== null}
            onClick={() => void request(kit)}
            data-testid={`demo-kit-${kit}`}
          >
            <span className="demo-kit-title">{busy === kit ? "Sending…" : TITLE[kit]}</span>
            <span className="demo-kit-desc">{purpose[kit]}</span>
          </button>
        ))}
      </div>
      {result && (
        <p className={result.ok ? "small text-good" : "small text-bad"} role="status" data-testid="demo-funds-result">
          {result.text}
        </p>
      )}
    </div>
  );
}
