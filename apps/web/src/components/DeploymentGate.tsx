import type { ReactNode } from "react";
import type { SelioClient } from "@selio/sdk";
import { describeError } from "../lib/errors";
import type { MarketMeta } from "../lib/market";
import { useNetwork } from "../lib/network-context";
import { Notice } from "./ui";

/** Renders `children` only when the selected network's deployment is loaded and its market is readable. */
export function DeploymentGate({
  children,
  head,
}: {
  children: (ctx: { selio: SelioClient; meta: MarketMeta }) => ReactNode;
  /** Shown above the notice while the market is not readable, for pages whose heading needs market data. */
  head?: ReactNode;
}) {
  const { deployment, selio, meta, info, rpcUrl } = useNetwork();
  if (deployment.status === "ready" && selio && meta.data) return <>{children({ selio, meta: meta.data })}</>;

  let notice: ReactNode;
  if (deployment.status === "loading") {
    notice = <p className="muted loading">Loading the {info.label} deployment…</p>;
  } else if (deployment.status === "missing") {
    notice = (
      <Notice tone="neutral" testid="not-deployed">
        <b>Selio is not deployed on {info.label} yet.</b> Pick another chain or scenario in the selector above to use the
        market now.
      </Notice>
    );
  } else if (deployment.status === "invalid") {
    notice = (
      <Notice tone="danger" testid="deployment-invalid">
        <b>The {info.label} deployment file is invalid:</b> {deployment.error}
      </Notice>
    );
  } else if (!selio || meta.loading || !meta.error) {
    notice = <p className="muted loading">Reading the market on {info.label}…</p>;
  } else {
    notice = (
      <Notice tone="danger" testid="rpc-error">
        <div className="stack-sm">
          <span>
            <b>Can't read Selio on {info.label}</b> ({rpcUrl}). {describeError(meta.error)}
          </span>
          <button type="button" className="btn btn--secondary btn--small" onClick={meta.reload}>
            Try again
          </button>
        </div>
      </Notice>
    );
  }
  return head ? (
    <div className="stack-lg">
      {head}
      {notice}
    </div>
  ) : (
    <>{notice}</>
  );
}
