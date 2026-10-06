import { useEffect, useRef, useState } from "react";
import { agentConfigured, revokeAgentFor, useAgentMe } from "../lib/agent";
import { describeError } from "../lib/errors";
import { shortAddress } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { useNetwork } from "../lib/network-context";
import { loadDynamic, useWallet, type WalletKind } from "../lib/wallet-context";
import { DemoFunds } from "./DemoFunds";
import { useDismiss } from "./dropdown";
import { EmbeddedSignIn } from "./EmbeddedSignIn";
import { ChevronDown } from "./Icons";

const CONNECTED_TITLE: Record<WalletKind, string> = {
  demo: "Demo wallet · burner key in this browser",
  injected: "Browser wallet",
  embedded: "Email or passkey wallet · Dynamic",
};

/** Other parts of the page (the exit agent panel) open the wallet menu with this window event. */
export const OPEN_WALLET_MENU_EVENT = "selio:open-wallet-menu";

interface ConnectOption {
  testid: string;
  title: string;
  desc: string;
  disabled?: boolean;
  select(): Promise<void> | void;
}

/** Header dropdown: connect a browser, demo or email wallet, then copy, disconnect, switch chain and get demo funds. */
export function WalletMenu() {
  const { info, refresh } = useNetwork();
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    setSignIn(false);
  };
  useDismiss(open, ref, close);
  const connected = wallet.address !== null;
  const embedded = wallet.kind === "embedded" ? wallet.embeddedAccount : null;

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(id);
  }, [copied]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_WALLET_MENU_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_WALLET_MENU_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) setNote(null);
  }, [open]);

  const passkeys = useAsync(async () => (await loadDynamic()).hasPasskey(), [embedded], { enabled: open && embedded !== null });
  const agent = useAgentMe({ enabled: open && embedded !== null && agentConfigured() });
  const agentOn = agent.data?.delegation?.status === "active";

  const options: ConnectOption[] = [
    {
      testid: "wallet-connect-injected",
      title: "Browser wallet",
      desc: wallet.hasInjected
        ? "MetaMask, Rabby or any injected wallet. Use it on the live networks."
        : "No browser wallet detected in this browser.",
      disabled: wallet.busy,
      // connectInjected never throws: a failure lands in wallet.error, shown when the menu reopens.
      select: () => wallet.connectInjected().finally(close),
    },
    {
      testid: "wallet-connect-demo",
      title: "Demo wallet",
      desc: "A burner key kept in this browser, for testnets and scenario forks only. Never send real funds to it.",
      select: () => {
        wallet.connectDemo();
        close();
      },
    },
    {
      testid: "wallet-connect-embedded",
      title: "Email or passkey",
      desc: wallet.hasEmbedded
        ? "A wallet secured by Dynamic, no extension needed. Signs on Monad Testnet; use the demo wallet on scenario forks."
        : "Not configured on this deployment yet: this build has no Dynamic environment. Use a browser wallet or the demo wallet.",
      disabled: !wallet.hasEmbedded,
      select: () => setSignIn(true),
    },
  ];

  const copy = () => {
    if (!wallet.address) return;
    navigator.clipboard.writeText(wallet.address).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  const addPasskey = async () => {
    setNote(null);
    try {
      await (await loadDynamic()).addPasskey();
      passkeys.reload();
      setNote({ ok: true, text: "Passkey added. Next time you can sign in with it, without an email code." });
    } catch (e) {
      setNote({ ok: false, text: describeError(e) });
    }
  };

  const revokeAgent = async () => {
    if (!embedded || !agent.api || !wallet.address) return;
    setRevoking(true);
    setNote(null);
    try {
      const result = await revokeAgentFor({
        api: agent.api,
        account: embedded,
        owner: wallet.address,
        grants: agent.data?.grants ?? [],
      });
      setNote(result.warning ? { ok: false, text: result.warning } : {
              ok: true,
              text: "The exit agent is revoked and has stopped. You can set the allowances you gave it back to zero in the Exit agent panel on Overview.",
            });
      agent.reload();
      refresh();
    } catch (e) {
      setNote({ ok: false, text: describeError(e) });
    } finally {
      setRevoking(false);
    }
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
        onClick={() => (open ? close() : setOpen(true))}
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
                    close();
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
              {wallet.kind === "embedded" && (
                <>
                  <p className="small muted">
                    A real wallet secured by Dynamic. On Monad Testnet, send it a little testnet MON for gas first.
                  </p>
                  {passkeys.data === false && (
                    <button
                      type="button"
                      className="btn btn--secondary btn--small self-start"
                      onClick={() => void addPasskey()}
                      data-testid="wallet-add-passkey"
                    >
                      Add a passkey
                    </button>
                  )}
                  {agentOn && (
                    <>
                      <p className="small" data-testid="wallet-agent-status">
                        Exit agent: on
                      </p>
                      <button
                        type="button"
                        className="btn btn--secondary btn--small self-start"
                        disabled={revoking}
                        onClick={() => void revokeAgent()}
                        data-testid="wallet-agent-revoke"
                      >
                        {revoking ? "Revoking…" : "Revoke agent"}
                      </button>
                      <p className="small muted">The exit agent keeps working after you sign out. Revoke it to stop it.</p>
                    </>
                  )}
                  {note && (
                    <p className={note.ok ? "small text-good" : "small text-bad"} role="status">
                      {note.text}
                    </p>
                  )}
                </>
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
          ) : signIn ? (
            <EmbeddedSignIn onDone={close} onBack={() => setSignIn(false)} />
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
