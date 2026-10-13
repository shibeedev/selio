import { useNetwork } from "../lib/network-context";
import { hrefFor } from "../lib/router";

export function Footer() {
  const { info, deployment, rpcUrl } = useNetwork();
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <span>Selio · the exit market for high-utilization lending pools</span>
        <span className="footer-links">
          <a href={hrefFor("developers")} data-testid="footer-developers">
            Developers
          </a>
          <span className="muted small" title={rpcUrl}>
            {info.label}
            {deployment.status === "ready" && ` · market ${deployment.deployment.market.slice(0, 10)}…`}
          </span>
        </span>
      </div>
    </footer>
  );
}
