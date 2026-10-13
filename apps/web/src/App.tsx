import type { ComponentType } from "react";
import { AlertBanner } from "./components/AlertBanner";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { NetworkProvider, useNetwork } from "./lib/network-context";
import { useRoute, type Route } from "./lib/router";
import { WalletProvider } from "./lib/wallet-context";
import { BuyPage } from "./pages/buy/BuyPage";
import { DevelopersPage } from "./pages/developers/DevelopersPage";
import { EarnPage } from "./pages/earn/EarnPage";
import { FrozenPage } from "./pages/frozen/FrozenPage";
import { HistoryPage } from "./pages/history/HistoryPage";
import { OverviewPage } from "./pages/overview/OverviewPage";
import { SellPage } from "./pages/sell/SellPage";

/** The page of every route. */
const PAGES: Record<Route, ComponentType> = {
  overview: OverviewPage,
  sell: SellPage,
  buy: BuyPage,
  earn: EarnPage,
  frozen: FrozenPage,
  history: HistoryPage,
  developers: DevelopersPage,
};

function Shell() {
  const route = useRoute();
  const { key } = useNetwork();
  const Page = PAGES[route];
  return (
    <div className="app">
      <Header route={route} />
      <AlertBanner />
      {/* Keyed by network so every form and cache starts fresh after a switch. */}
      <main key={`${route}:${key}`} className="container page" data-testid={`page-${route}`}>
        <Page />
      </main>
      <Footer />
    </div>
  );
}

export function App() {
  return (
    <NetworkProvider>
      <WalletProvider>
        <Shell />
      </WalletProvider>
    </NetworkProvider>
  );
}
