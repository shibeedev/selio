import { useEffect, useRef, useState } from "react";
import { shortAddress } from "../lib/format";
import { useNetwork } from "../lib/network-context";
import { useWallet, type WalletKind } from "../lib/wallet-context";
import { DemoFunds } from "./DemoFunds";
import { useDismiss } from "./dropdown";
import { ChevronDown } from "./Icons";

const CONNECTED_TITLE: Record<WalletKind, string> = {
  demo: "Demo wallet · burner key in this browser",
  injected: "Browser wallet",
};

interface ConnectOption {
  testid: string;
  title: string;
  desc: string;
  disabled?: boolean;
  select(): Promise<void> | void;
}

/** Header dropdown: connect a browser or demo wallet, then copy, disconnect, switch chain and get demo funds. */
export function WalletMenu() {
  const { info } = useNetwork();
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const connected = wallet.address !== null;

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(id);
  }, [copied]);

  const options: ConnectOption[] = [
    {
      testid: "wallet-connect-injected",
      title: "Browser wallet",
      desc: wallet.hasInjected
        ? "MetaMask, Rabby or any injected wallet. Use it on the live networks."
        : "No browser wallet detected in this browser.",
      disabled: wallet.busy,
      // connectInjected never throws: a failure lands in wallet.error, shown when the menu reopens.
      select: () => wallet.connectInjected().finally(() => setOpen(false)),
    },
    {
      testid: "wallet-connect-demo",
      title: "Demo wallet",
      desc: "A burner key kept in this browser, for testnets and scenario forks only. Never send real funds to it.",
      select: () => {
        wallet.connectDemo();
        setOpen(false);
      },
    },
  ];

  const copy = () => {
    if (!wallet.address) return;
    navigator.clipboard.writeText(wallet.address).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className="wallet-btn"
        aria-expanded={open}
        aria-haspopup="true"
        data-testid="wallet-button"
        data-connected={connected ? "true" : "false"}
        data-address={wallet.address ?? ""}
        onClick={() => setOpen((o) => !o)}
      >
        {connected && wallet.address ? (
          <>
            <span className={wallet.wrongChain ? "dot dot--warn" : "dot dot--live"} />
            <span className="mono">{shortAddress(wallet.address)}</span>
            {wallet.kind === "demo" && <span className="wallet-tag">demo</span>}
          </>
        ) : (
          <span>Connect wallet</span>
        )}
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu wallet-menu">
          {connected && wallet.address && wallet.kind ? (
            <div className="stack-sm">
              <div className="menu-group-title">{CONNECTED_TITLE[wallet.kind]}</div>
              <div className="wallet-address mono" data-testid="wallet-address">
                {wallet.address}
              </div>
              <div className="row-sm">
                <button type="button" className="btn btn--secondary btn--small" onClick={copy}>
                  {copied ? "Copied" : "Copy address"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  data-testid="wallet-disconnect"
                  onClick={() => {
                    wallet.disconnect();
                    setOpen(false);
                  }}
                >
                  Disconnect
                </button>
              </div>
              {wallet.kind === "demo" && (
                <p className="small muted">
                  For testnets and forks only: the key sits unencrypted in this browser's storage.
                  {!info.isFork && " On a live testnet, send it a little testnet MON for gas first."}
                </p>
              )}
              {wallet.wrongChain && (
                <button
                  type="button"
                  className="btn btn--primary btn--small"
                  data-testid="wallet-switch-chain"
                  onClick={() => void wallet.ensureChain().catch(() => undefined)}
                >
                  Switch wallet to {info.label}
                </button>
              )}
              {wallet.writeBlockedReason && <p className="small text-warn">{wallet.writeBlockedReason}</p>}
              <DemoFunds kits={["seller", "borrower", "bidder"]} />
            </div>
          ) : (
            <div className="stack-sm">
              <div className="menu-group-title">Connect to sign transactions</div>
              {options.map((option) => (
                <button
                  key={option.testid}
                  type="button"
                  className="menu-option"
                  data-testid={option.testid}
                  disabled={option.disabled}
                  onClick={() => void option.select()}
                >
                  <span className="menu-option-title">{option.title}</span>
                  <span className="menu-option-desc">{option.desc}</span>
                </button>
              ))}
              {wallet.error && <p className="small text-bad">{wallet.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
