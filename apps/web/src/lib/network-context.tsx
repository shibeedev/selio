import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { NETWORKS, SelioClient, type NetworkInfo, type NetworkKey } from "@selio/sdk";
import { loadDeployment, type DeploymentState } from "./deployment";
import { rpcEnvName, rpcUrlFor } from "./env";
import { readStorage, useAsync, writeStorage, type AsyncState } from "./hooks";
import { loadMarketMeta, type MarketMeta } from "./market";
import { DEFAULT_NETWORK, isNetworkKey } from "./networks";

export interface NetworkContextValue {
  key: NetworkKey;
  info: NetworkInfo;
  rpcUrl: string;
  setKey(key: NetworkKey): void;
  publicClient: PublicClient;
  deployment: DeploymentState;
  selio: SelioClient | null;
  meta: AsyncState<MarketMeta>;
  /** Increments after confirmed transactions and faucet grants; views reload on it. */
  refreshKey: number;
  refresh(): void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

const STORAGE_KEY = "selio.network";

/** The URL query wins (and is not stored), then the last choice in this browser, then the default. */
function initialNetwork(): NetworkKey {
  const fromUrl = new URLSearchParams(window.location.search).get("network");
  if (isNetworkKey(fromUrl)) return fromUrl;
  const stored = readStorage(STORAGE_KEY);
  return isNetworkKey(stored) ? stored : DEFAULT_NETWORK;
}

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [key, setKeyState] = useState<NetworkKey>(initialNetwork);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loaded, setLoaded] = useState<{ key: NetworkKey; state: DeploymentState } | null>(null);

  const info = NETWORKS[key];
  const rpcUrl = rpcUrlFor(key);

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: info.chain,
        transport: http(rpcUrl),
        batch: info.chain.contracts?.multicall3 ? { multicall: true } : undefined,
        pollingInterval: info.isFork ? 1_000 : 2_000,
      }) as PublicClient,
    [info, rpcUrl],
  );

  useEffect(() => {
    let cancelled = false;
    void loadDeployment(key).then((state) => {
      if (!cancelled) setLoaded({ key, state });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const deployment: DeploymentState = loaded && loaded.key === key ? loaded.state : { status: "loading" };

  const selio = useMemo(
    () => (deployment.status === "ready" ? new SelioClient(deployment.deployment, publicClient) : null),
    [deployment, publicClient],
  );

  const rpcHint = `Check that ${rpcUrl} serves ${info.label}; for a local fork set ${rpcEnvName(key)} to the fork's RPC.`;
  const metaState = useAsync(
    async () => ({ client: selio, meta: await loadMarketMeta(selio as SelioClient, rpcHint) }),
    [selio],
    { enabled: selio !== null },
  );
  // Only hand out metadata read through the current client, never a previous network's.
  const metaData = metaState.data && metaState.data.client === selio ? metaState.data.meta : undefined;
  const meta: AsyncState<MarketMeta> = {
    data: metaData,
    error: metaData ? null : metaState.error,
    loading: !metaData && (metaState.loading || (selio !== null && !metaState.error)),
    reload: metaState.reload,
  };

  const setKey = useCallback((next: NetworkKey) => {
    setKeyState(next);
    writeStorage(STORAGE_KEY, next);
  }, []);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

  const value: NetworkContextValue = {
    key,
    info,
    rpcUrl,
    setKey,
    publicClient,
    deployment,
    selio,
    meta,
    refreshKey,
    refresh,
  };
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("useNetwork outside NetworkProvider");
  return value;
}
