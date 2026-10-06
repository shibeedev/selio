import { useState, type FormEvent } from "react";
import {
  clearAlertSession,
  formatMaskedWebhook,
  isSessionRejected,
  SESSION_EXPIRED_MESSAGE,
  signInForAlerts,
  useAlertSession,
  webhookInputError,
} from "../../lib/alerts";
import { createAlert, deleteAlert, listAlerts } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { formatBps, parsePercentToBps, shortAddress } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useNetwork } from "../../lib/network-context";
import { useWallet } from "../../lib/wallet-context";

/** Utilization alerts belong to a wallet: they are shown and changed only after a sign-in with it. */
export function AlertForm({ threshold, onThreshold }: { threshold: string; onThreshold: (value: string) => void }) {
  const { key, info } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const session = useAlertSession(address);
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [version, setVersion] = useState(0);

  const bps = parsePercentToBps(threshold);
  const thresholdError = bps === null || bps <= 0 || bps > 10_000 ? "Enter a utilization between 0.01 and 100" : null;
  const webhookError = webhookInputError(webhook);
  const canSave = !!address && !!session && !thresholdError && !webhookError && !busy;

  // A 401 means the backend no longer knows this session: drop it and say so.
  const handleError = (err: unknown) => {
    if (isSessionRejected(err) && address) {
      clearAlertSession(address);
      setStatus({ ok: false, text: SESSION_EXPIRED_MESSAGE });
    } else {
      setStatus({ ok: false, text: describeError(err) });
    }
  };

  const alerts = useAsync(
    async () => {
      try {
        return await listAlerts(address!, session!.token);
      } catch (e) {
        if (isSessionRejected(e)) handleError(e);
        throw e;
      }
    },
    [address, session?.token, version],
    { enabled: !!address && !!session },
  );

  const signIn = async () => {
    if (!address) return;
    setSigningIn(true);
    setStatus(null);
    try {
      await signInForAlerts({ address, chainId: info.chain.id, sign: wallet.signMessage });
    } catch (e) {
      setStatus({ ok: false, text: describeError(e) });
    } finally {
      setSigningIn(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !address || !session || bps === null) return;
    setBusy(true);
    setStatus(null);
    const url = webhook.trim();
    try {
      await createAlert({ network: key, thresholdBps: bps, owner: address, ...(url ? { webhookUrl: url } : {}) }, session.token);
      setStatus({ ok: true, text: `Saved. You'll be told when ${info.label} crosses ${formatBps(bps)}.` });
      setVersion((v) => v + 1);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!address || !session) return;
    try {
      await deleteAlert(id, address, session.token);
      setVersion((v) => v + 1);
    } catch (err) {
      handleError(err);
    }
  };

  const rows = session ? (alerts.data ?? []).filter((a) => a.network === key) : [];

  return (
    <form className="panel alert-form stack-sm" aria-labelledby="h-alert" onSubmit={(e) => void save(e)}>
      <h3 id="h-alert" className="h3">
        Alert me
      </h3>
      <p className="small muted">Hear about a freeze before the exits fill up, so you can sell or bid early.</p>
      <label className="label" htmlFor="alert-th">
        When utilization rises above
      </label>
      <div className="input-row input-row--narrow">
        <input
          id="alert-th"
          className="input input--mono"
          type="text"
          inputMode="decimal"
          value={threshold}
          onChange={(e) => onThreshold(e.target.value)}
          aria-invalid={thresholdError ? true : undefined}
          data-testid="alert-threshold"
        />
        <span>%</span>
      </div>
      {thresholdError && <span className="hint text-bad">{thresholdError}</span>}
      <label className="label" htmlFor="alert-hook">
        Webhook URL (optional)
      </label>
      <input
        id="alert-hook"
        className="input"
        type="url"
        placeholder="https://"
        value={webhook}
        onChange={(e) => setWebhook(e.target.value)}
        aria-invalid={webhookError ? true : undefined}
        data-testid="alert-webhook"
      />
      <span className={webhookError ? "hint text-bad" : "hint"}>
        {webhookError ?? "You always get an in-app banner. Add a webhook to reach your bot, vault or curator tooling."}
      </span>
      {address && !session ? (
        <>
          <p className="small muted">
            Alerts belong to your wallet. Sign one message to prove it; it sends no transaction and costs no gas.
          </p>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={signingIn}
            onClick={() => void signIn()}
            data-testid="alert-signin"
          >
            {signingIn ? "Signing in…" : "Sign in with your wallet"}
          </button>
        </>
      ) : (
        <>
          {session && (
            <p className="small muted" data-testid="alert-session">
              Signed in as <span className="mono">{shortAddress(session.owner)}</span>
            </p>
          )}
          <button type="submit" className="btn btn--primary" disabled={!canSave} data-testid="alert-save">
            {busy ? "Saving…" : address ? "Save alert" : "Connect a wallet to save an alert"}
          </button>
        </>
      )}
      {status && (
        <p className={status.ok ? "small text-good" : "small text-bad"} role="status" data-testid="alert-status">
          {status.text}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="alert-list">
          {rows.map((a) => (
            <li key={a.id} data-testid={`alert-row-${a.id}`}>
              <span className="small">
                Above <b className="mono">{formatBps(a.thresholdBps)}</b>
                {a.webhook ? ` · webhook ${formatMaskedWebhook(a.webhook)}` : " · in-app"}
              </span>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => void remove(a.id)}
                data-testid={`alert-delete-${a.id}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
