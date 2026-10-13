import { useNetwork } from "../lib/network-context";
import { networkKind } from "../lib/networks";
import { hrefFor, type Route } from "../lib/router";
import { CodeIcon, LogoMark } from "./Icons";
import { NetworkSelector } from "./NetworkSelector";
import { WalletMenu } from "./WalletMenu";

/** Main navigation, in order. Developers sits apart, on the right. */
export const NAV_ITEMS: { route: Route; label: string; testid: string }[] = [
  { route: "overview", label: "Overview", testid: "nav-overview" },
  { route: "sell", label: "Sell", testid: "nav-sell" },
  { route: "buy", label: "Buy & repay", testid: "nav-buy" },
  { route: "earn", label: "Earn", testid: "nav-earn" },
  { route: "frozen", label: "Frozen collateral", testid: "nav-frozen" },
  { route: "history", label: "History", testid: "nav-history" },
];

export function Header({ route }: { route: Route }) {
  const { info } = useNetwork();
  const kind = networkKind(info);
  const context = info.description.startsWith(kind) ? info.description : `${kind} · ${info.description}`;
  return (
    <>
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href={hrefFor("overview")} aria-label="Selio home">
            <LogoMark size={30} />
            <span className="brand-name">Selio</span>
          </a>
          <nav className="main-nav" aria-label="Main">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.route}
                className="nav-link"
                href={hrefFor(item.route)}
                aria-current={route === item.route ? "page" : undefined}
                data-testid={item.testid}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="header-right">
            <a
              className="dev-link"
              href={hrefFor("developers")}
              aria-current={route === "developers" ? "page" : undefined}
              data-testid="nav-developers"
            >
              <CodeIcon size={14} />
              Developers
            </a>
            <NetworkSelector />
            <WalletMenu />
          </div>
        </div>
      </header>
      <div className={info.isFork ? "ctx-bar ctx-bar--fork" : "ctx-bar ctx-bar--live"} data-testid="network-context">
        <div className="container ctx-inner">
          <b>{info.label}</b>
          <span>{context}</span>
          {info.isFork && (
            <span data-testid="fork-shared-note">
              Every visitor shares this fork and can change its state; it is reset once a day.
            </span>
          )}
        </div>
      </div>
    </>
  );
}
