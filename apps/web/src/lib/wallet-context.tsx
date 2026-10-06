import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  http,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { WalletAccount } from "@dynamic-labs-sdk/client";
import { dynamicEnvironmentId } from "./env";
import { describeError } from "./errors";
import { readStorage, writeStorage } from "./hooks";
import { useNetwork } from "./network-context";

/** The Dynamic SDK loads on first use only, so it stays out of the initial bundle. */
export const loadDynamic = () => import("./dynamic");

/** A new connection kind adds its name here and its client below. */
export type WalletKind = "injected" | "demo" | "embedded";

export type ConnectedWalletClient = WalletClient<Transport, Chain, Account>;

export interface WalletContextValue {
  kind: WalletKind | null;
  address: Address | null;
  walletClient: ConnectedWalletClient | null;
  hasInjected: boolean;
  /** The build has a Dynamic environment, so the email or passkey wallet can sign in. */
  hasEmbedded: boolean;
  /** The Dynamic account of the connected email or passkey wallet. */
  embeddedAccount: WalletAccount | null;
  busy: boolean;
  error: string | null;
  wrongChain: boolean;
  /** Why writes are disabled, or null. */
  writeBlockedReason: string | null;
  connectInjected(): Promise<void>;
  connectDemo(): void;
  /** After a Dynamic sign-in: connects its embedded wallet (created on a first sign-in); throws on failure. */
  connectEmbedded(): Promise<void>;
  disconnect(): void;
  ensureChain(): Promise<void>;
  /** Client for the SDK's typed-data signing. */
  typedDataSigner(): WalletClient | null;
  /** EIP-191 signature of a text message by the connected wallet (alert sign-in). */
  signMessage(message: string): Promise<Hex>;
}

const KIND_KEY = "selio.wallet.kind";
const DEMO_KEY = "selio.demoWallet.privateKey";

const WalletContext = createContext<WalletContextValue | null>(null);

function storedDemoKey(): Hex | null {
  const key = readStorage(DEMO_KEY);
  return key && /^0x[0-9a-fA-F]{64}$/.test(key) ? (key as Hex) : null;
}

function hasErrorCode(err: unknown, code: number): boolean {
  let current = err;
  for (let depth = 0; depth < 10 && current !== null && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const hasEmbedded = dynamicEnvironmentId() !== null;

interface EmbeddedWallet {
  account: WalletAccount;
  /** Created asynchronously by Dynamic, so it is held in state, unlike the other two clients. */
  client: ConnectedWalletClient;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { info, rpcUrl } = useNetwork();
  const provider = typeof window !== "undefined" ? window.ethereum : undefined;
  const [kind, setKind] = useState<WalletKind | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedWallet | null>(null);
  const [injectedAddress, setInjectedAddress] = useState<Address | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [demoKey, setDemoKey] = useState<Hex | null>(storedDemoKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore the last connection without prompting.
  useEffect(() => {
    const saved = readStorage(KIND_KEY);
    if (saved === "demo" && storedDemoKey()) {
      setKind("demo");
    } else if (saved === "injected" && provider) {
      provider
        .request({ method: "eth_accounts" })
        .then((accounts) => {
          const first = accounts[0];
          if (first) {
            setInjectedAddress(getAddress(first));
            setKind("injected");
          }
        })
        .catch(() => undefined);
    }
  }, [provider]);

  const connectEmbedded = useCallback(async () => {
    const d = await loadDynamic();
    const account = await d.ensureEmbeddedAccount();
    const client = await d.embeddedWalletClient(account);
    setEmbedded({ account, client });
    setKind("embedded");
    setError(null);
    writeStorage(KIND_KEY, "embedded");
  }, []);

  // A stored email or passkey connection comes back without prompting while its Dynamic session lasts.
  useEffect(() => {
    if (readStorage(KIND_KEY) !== "embedded") return;
    if (!hasEmbedded) {
      writeStorage(KIND_KEY, null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const d = await loadDynamic();
      await d.ready();
      if (cancelled) return;
      if (d.signedIn()) await connectEmbedded();
      else writeStorage(KIND_KEY, null);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectEmbedded]);

  // The Dynamic session ended elsewhere (expiry, a logout in another tab): the embedded wallet disconnects.
  useEffect(() => {
    if (kind !== "embedded") return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void loadDynamic().then((d) => {
      if (cancelled) return;
      off = d.onDynamic("userChanged", ({ user }) => {
        if (user) return;
        setKind((k) => (k === "embedded" ? null : k));
        setEmbedded(null);
        if (readStorage(KIND_KEY) === "embedded") writeStorage(KIND_KEY, null);
      });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [kind]);

  useEffect(() => {
    if (!provider) return;
    const onAccounts = (accounts: readonly Address[]) => setInjectedAddress(accounts[0] ? getAddress(accounts[0]) : null);
    const onChain = (chainId: string) => setWalletChainId(Number(chainId));
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    provider
      .request({ method: "eth_chainId" })
      .then((id) => setWalletChainId(Number(id)))
      .catch(() => undefined);
    return () => {
      provider.removeListener("accountsChanged", onAccounts);
      provider.removeListener("chainChanged", onChain);
    };
  }, [provider]);

  const demoAccount = useMemo(() => (demoKey ? privateKeyToAccount(demoKey) : null), [demoKey]);

  const walletClient = useMemo<ConnectedWalletClient | null>(() => {
    if (kind === "demo" && demoAccount) {
      // The burner signs locally and sends through the network's RPC.
      return createWalletClient({ account: demoAccount, chain: info.chain, transport: http(rpcUrl) });
    }
    if (kind === "injected" && injectedAddress && provider) {
      return createWalletClient({ account: injectedAddress, chain: info.chain, transport: custom(provider) });
    }
    if (kind === "embedded" && embedded) return embedded.client;
    return null;
  }, [kind, demoAccount, injectedAddress, provider, info, rpcUrl, embedded]);

  const address: Address | null =
    kind === "demo"
      ? (demoAccount?.address ?? null)
      : kind === "injected"
        ? injectedAddress
        : kind === "embedded" && embedded
          ? getAddress(embedded.account.address)
          : null;

  const wrongChain = kind === "injected" && walletChainId !== null && walletChainId !== info.chain.id;

  // Both forks reuse Monad mainnet's chain id, so a browser wallet would sign for, and send to, the real chain.
  const writeBlockedReason = !address
    ? "Connect a wallet first."
    : kind === "injected" && info.isFork
      ? `${info.label} is a local fork that reuses chain id ${info.chain.id}, so a browser wallet would send to the real chain. Use the demo wallet here.`
      : kind === "embedded" && info.isFork
        ? `${info.label} is a scenario fork that reuses Monad mainnet's chain id ${info.chain.id}. Your email or passkey wallet is a real wallet, so Selio does not let it sign there. Use the demo wallet on scenario forks.`
        : null;

  const connectInjected = useCallback(async () => {
    setError(null);
    if (!provider) {
      setError("No browser wallet found. Install one, or use the demo wallet on testnets and forks.");
      return;
    }
    setBusy(true);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const first = accounts[0];
      if (!first) {
        setError("The wallet returned no account.");
        return;
      }
      setInjectedAddress(getAddress(first));
      setKind("injected");
      writeStorage(KIND_KEY, "injected");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, [provider]);

  const connectDemo = useCallback(() => {
    setError(null);
    let key = storedDemoKey();
    if (!key) {
      key = generatePrivateKey();
      writeStorage(DEMO_KEY, key);
    }
    setDemoKey(key);
    setKind("demo");
    writeStorage(KIND_KEY, "demo");
  }, []);

  // The demo key stays in storage, so reconnecting the demo wallet returns the same address. The email or
  // passkey wallet also signs out of Dynamic, so a shared computer keeps no session.
  const disconnect = useCallback(() => {
    setKind(null);
    setError(null);
    writeStorage(KIND_KEY, null);
    if (kind === "embedded") {
      setEmbedded(null);
      void loadDynamic()
        .then((d) => d.logout())
        .catch(() => undefined);
    }
  }, [kind]);

  const ensureChain = useCallback(async () => {
    if (kind === "embedded") {
      if (embedded && info.key === "monad-testnet") await (await loadDynamic()).switchToTestnet(embedded.account);
      return;
    }
    if (kind !== "injected" || !walletClient) return;
    const current = await walletClient.getChainId();
    if (current !== info.chain.id) {
      try {
        await walletClient.switchChain({ id: info.chain.id });
      } catch (e) {
        if (!hasErrorCode(e, 4902)) throw e;
        await walletClient.addChain({ chain: { ...info.chain, rpcUrls: { default: { http: [rpcUrl] } } } });
        await walletClient.switchChain({ id: info.chain.id });
      }
    }
    setWalletChainId(info.chain.id);
  }, [kind, walletClient, info, rpcUrl, embedded]);

  const typedDataSigner = useCallback((): WalletClient | null => {
    if (!walletClient) return null;
    if (kind === "demo" && demoAccount) {
      // The SDK may pass the account as an address, which viem would route to the RPC; the burner key signs locally.
      return {
        ...walletClient,
        signTypedData: (args: Parameters<typeof demoAccount.signTypedData>[0]) => demoAccount.signTypedData(args),
      } as unknown as WalletClient;
    }
    return walletClient;
  }, [walletClient, kind, demoAccount]);

  // Not gated by writeBlockedReason: the sign-in message sends nothing, so a browser wallet may sign it on a fork too.
  const signMessage = useCallback(
    async (message: string): Promise<Hex> => {
      if (!walletClient) throw new Error("Connect a wallet first.");
      return walletClient.signMessage({ account: walletClient.account, message });
    },
    [walletClient],
  );

  const value: WalletContextValue = {
    kind,
    address,
    walletClient,
    hasInjected: !!provider,
    hasEmbedded,
    embeddedAccount: kind === "embedded" ? (embedded?.account ?? null) : null,
    busy,
    error,
    wrongChain,
    writeBlockedReason,
    connectInjected,
    connectDemo,
    connectEmbedded,
    disconnect,
    ensureChain,
    typedDataSigner,
    signMessage,
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside WalletProvider");
  return value;
}
