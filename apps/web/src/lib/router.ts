import { useEffect, useState } from "react";

export type Route = "overview" | "sell" | "buy" | "earn" | "frozen" | "history" | "developers";

/** Hash path of every route. A new page adds its route here and its component in App.tsx. */
export const ROUTE_PATHS: Record<Route, string> = {
  overview: "/",
  sell: "/sell",
  buy: "/buy",
  earn: "/earn",
  frozen: "/frozen-collateral",
  history: "/history",
  developers: "/developers",
};

export function hrefFor(route: Route): string {
  return `#${ROUTE_PATHS[route]}`;
}

/** Exact path match; query strings inside the hash are ignored and anything unknown is the Overview. */
export function routeFromHash(hash: string): Route {
  const path = (hash.startsWith("#") ? hash.slice(1) : hash).split("?")[0] || "/";
  const routes = Object.keys(ROUTE_PATHS) as Route[];
  return routes.find((r) => ROUTE_PATHS[r] === path) ?? "overview";
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => {
      setRoute(routeFromHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}
