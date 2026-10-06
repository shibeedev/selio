import { useState } from "react";
import { NETWORKS } from "@selio/sdk";
import { clearAlertSession, isSessionRejected, useAlertSession } from "../lib/alerts";
import { getAlertEvents, type AlertEvent } from "../lib/api";
import { formatBps } from "../lib/format";
import { readStorage, useAsync, writeStorage } from "../lib/hooks";
import { isNetworkKey } from "../lib/networks";
import { useWallet } from "../lib/wallet-context";

const DISMISSED_KEY = "selio.alerts.dismissed";
const eventKey = (e: AlertEvent) => `${e.network}:${e.at}:${e.thresholdBps}`;

function readDismissed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readStorage(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * In-app delivery of the wallet's alert events (every network), silent when the backend is offline.
 * It never asks for a signature: the sign-in happens in the alert form.
 */
export function AlertBanner() {
  const { address } = useWallet();
  const session = useAlertSession(address);
  const [dismissed, setDismissed] = useState(readDismissed);
  const events = useAsync(
    async () => {
      if (!address || !session) return [];
      try {
        return await getAlertEvents(address, session.token);
      } catch (e) {
        if (isSessionRejected(e)) clearAlertSession(address);
        throw e;
      }
    },
    [address, session?.token],
    { enabled: !!address && !!session, pollMs: 30_000 },
  );

  const visible = (events.data ?? [])
    .filter((e) => !dismissed.has(eventKey(e)))
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  if (!address || !session || visible.length === 0) return null;

  const dismiss = (e: AlertEvent) => {
    const next = new Set(dismissed);
    next.add(eventKey(e));
    setDismissed(next);
    writeStorage(DISMISSED_KEY, JSON.stringify([...next].slice(-200)));
  };

  return (
    <div className="alert-banners container" data-testid="alert-banner">
      {visible.map((e) => {
        const label = isNetworkKey(e.network) ? NETWORKS[e.network].label : e.network;
        const ms = e.at < 1e12 ? e.at * 1000 : e.at;
        const time = new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
        return (
          <div key={eventKey(e)} className="notice notice--warn alert-banner" role="status">
            <span>
              <b>
                Utilization on {label} hit {formatBps(e.utilizationBps)}
              </b>
              , above your alert at {formatBps(e.thresholdBps)} ({time}). Exits are getting scarce: sell early or check what
              the pool can still pay out.
            </span>
            <span className="row-sm">
              <a className="btn btn--secondary btn--small" href="#/">
                Exit capacity
              </a>
              <button type="button" className="btn btn--secondary btn--small" onClick={() => dismiss(e)}>
                Dismiss
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
