import { useState, type FormEvent } from "react";
import type { OTPVerification } from "../lib/dynamic";
import { describeError } from "../lib/errors";
import { loadDynamic, useWallet } from "../lib/wallet-context";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The Dynamic client, initialized; an unreachable Dynamic gets a message the user can act on. */
async function dynamicReady() {
  const d = await loadDynamic();
  try {
    await d.ready();
  } catch (e) {
    throw new Error(`Dynamic sign-in is unavailable right now (${describeError(e)}). Try again in a minute, or use another wallet.`);
  }
  return d;
}

/** Email code or passkey sign-in with Dynamic, inside the wallet menu; a first sign-in creates the wallet. */
export function EmbeddedSignIn({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const wallet = useWallet();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState<OTPVerification | null>(null);
  const [busy, setBusy] = useState<"send" | "verify" | "passkey" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: "send" | "verify" | "passkey", step: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const sendCode = (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) return;
    void run("send", async () => {
      const d = await dynamicReady();
      setOtp(await d.sendEmailCode(email.trim()));
      setCode("");
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (!otp || !code.trim()) return;
    void run("verify", async () => {
      const d = await loadDynamic();
      await d.verifyEmailCode(otp, code.trim());
      await wallet.connectEmbedded();
      onDone();
    });
  };

  const passkey = () =>
    void run("passkey", async () => {
      const d = await dynamicReady();
      await d.signInWithPasskey();
      await wallet.connectEmbedded();
      onDone();
    });

  return (
    <div className="stack-sm" data-testid="embedded-signin">
      <div className="menu-group-title">Email or passkey · Dynamic</div>
      <form className="stack-sm" onSubmit={sendCode}>
        <label className="label" htmlFor="embedded-email">
          Email
        </label>
        <input
          id="embedded-email"
          className="input"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          data-testid="embedded-email"
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={busy !== null || !EMAIL.test(email.trim())}
          data-testid="embedded-send-code"
        >
          {busy === "send" ? "Sending…" : "Send code"}
        </button>
      </form>
      {otp && (
        <form className="stack-sm" onSubmit={verify}>
          <label className="label" htmlFor="embedded-code">
            Code from your email
          </label>
          <input
            id="embedded-code"
            className="input input--mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="embedded-code"
          />
          <button type="submit" className="btn btn--primary" disabled={busy !== null || !code.trim()} data-testid="embedded-verify">
            {busy === "verify" ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}
      <button
        type="button"
        className="btn btn--secondary"
        disabled={busy !== null}
        onClick={passkey}
        data-testid="embedded-passkey"
      >
        {busy === "passkey" ? "Signing in…" : "Sign in with a passkey"}
      </button>
      <p className="small muted">A passkey works once you have added one while signed in; the first sign-in uses an email code.</p>
      {error && <p className="small text-bad">{error}</p>}
      <button type="button" className="btn btn--secondary btn--small self-start" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
