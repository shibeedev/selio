// Loaded only with import() (see loadDynamic in wallet-context.tsx), so the Dynamic SDK stays out of the
// initial bundle. Embedded wallets only: browser wallets keep Selio's own EIP-1193 path.
import {
  createDynamicClient,
  getPasskeys,
  getWalletAccounts,
  initializeClient,
  logout as dynamicLogout,
  onEvent,
  registerPasskey,
  sendEmailOTP,
  signInWithPasskey as dynamicSignInWithPasskey,
  switchActiveNetwork,
  verifyOTP,
  type DynamicClient,
  type DynamicEvents,
  type NetworkData,
  type OTPVerification,
  type WalletAccount,
} from "@dynamic-labs-sdk/client";
import {
  createWaasWalletAccounts,
  delegateWaasKeyShares,
  getChainsMissingWaasWalletAccounts,
  hasDelegatedAccess,
  revokeWaasDelegation,
} from "@dynamic-labs-sdk/client/waas";
import { isEvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { addWaasEvmExtension } from "@dynamic-labs-sdk/evm/waas";
import type { Account, Chain, Transport, WalletClient } from "viem";
import { monadTestnet } from "viem/chains";
import { dynamicEnvironmentId, rpcUrlFor } from "./env";

export type { OTPVerification, WalletAccount };

/** Dynamic names EVM networks by chain id; the embedded wallet signs only on Monad Testnet. */
export const MONAD_TESTNET_NETWORK_ID = String(monadTestnet.id);

/**
 * Keeps exactly one network, Monad Testnet, served by Selio's RPC for it; appends it when the dashboard
 * does not list chain 10143.
 */
export function selioNetworksData(networks: NetworkData[], rpcUrl: string): NetworkData[] {
  const listed = networks.find((n) => n.chain === "EVM" && n.networkId === MONAD_TESTNET_NETWORK_ID);
  const base: NetworkData = listed ?? {
    blockExplorerUrls: monadTestnet.blockExplorers ? [monadTestnet.blockExplorers.default.url] : [],
    chain: "EVM",
    displayName: monadTestnet.name,
    iconUrl: "",
    name: monadTestnet.name,
    nativeCurrency: { ...monadTestnet.nativeCurrency },
    networkId: MONAD_TESTNET_NETWORK_ID,
    rpcUrls: { http: [rpcUrl] },
    testnet: true,
  };
  return [{ ...base, rpcUrls: { http: [rpcUrl] } }];
}

let client: DynamicClient | null = null;
let initializing: Promise<void> | null = null;

export function getDynamicClient(): DynamicClient {
  if (client) return client;
  const environmentId = dynamicEnvironmentId();
  if (!environmentId) throw new Error("Email and passkey sign-in is not configured on this deployment.");
  client = createDynamicClient({
    environmentId,
    // Initialized by ready(), so a failure is caught and the next attempt can start over.
    autoInitialize: false,
    metadata: { name: "Selio", universalLink: window.location.origin },
    transformers: { networksData: (networks) => selioNetworksData(networks, rpcUrlFor("monad-testnet")) },
  });
  addWaasEvmExtension(client);
  return client;
}

/** Initializes the client once; a client whose initialization failed cannot retry, so the next call makes a new one. */
export function ready(): Promise<void> {
  if (!initializing) {
    initializing = initializeClient(getDynamicClient()).catch((e: unknown) => {
      client = null;
      initializing = null;
      throw e;
    });
  }
  return initializing;
}

export function signedIn(): boolean {
  return getDynamicClient().user !== null;
}

export function sendEmailCode(email: string): Promise<OTPVerification> {
  return sendEmailOTP({ email }, getDynamicClient());
}

export async function verifyEmailCode(otpVerification: OTPVerification, code: string): Promise<void> {
  await verifyOTP({ otpVerification, verificationToken: code }, getDynamicClient());
}

/** Returning users only: a passkey is added while signed in, after a first sign-in with an email code. */
export async function signInWithPasskey(): Promise<void> {
  await dynamicSignInWithPasskey({}, getDynamicClient());
}

export async function addPasskey(): Promise<void> {
  await registerPasskey({}, getDynamicClient());
}

export async function hasPasskey(): Promise<boolean> {
  return (await getPasskeys(getDynamicClient())).length > 0;
}

/** Creates the embedded wallet on a first sign-in, then returns its EVM account. */
export async function ensureEmbeddedAccount(): Promise<WalletAccount> {
  const c = getDynamicClient();
  const missing = getChainsMissingWaasWalletAccounts(c);
  if (missing.length > 0) await createWaasWalletAccounts({ chains: missing }, c);
  const account = getWalletAccounts(c).find(isEvmWalletAccount);
  if (!account) throw new Error("Dynamic returned no EVM wallet for this sign-in.");
  return account;
}

export function embeddedWalletClient(account: WalletAccount): Promise<WalletClient<Transport, Chain, Account>> {
  if (!isEvmWalletAccount(account)) throw new Error("Not an EVM wallet account.");
  return createWalletClientForWalletAccount({ walletAccount: account }, getDynamicClient());
}

export function switchToTestnet(account: WalletAccount): Promise<void> {
  return switchActiveNetwork({ networkId: MONAD_TESTNET_NETWORK_ID, walletAccount: account }, getDynamicClient());
}

/** The JWT of the signed-in user; the exit agent's API requires it. */
export function jwt(): string | null {
  return getDynamicClient().token;
}

export function hasDelegation(account: WalletAccount): boolean {
  return hasDelegatedAccess({ walletAccount: account }, getDynamicClient());
}

export function grantDelegation(account: WalletAccount): Promise<void> {
  return delegateWaasKeyShares({ walletAccount: account }, getDynamicClient());
}

export function revokeDelegation(account: WalletAccount): Promise<void> {
  return revokeWaasDelegation({ walletAccount: account }, getDynamicClient());
}

export function logout(): Promise<void> {
  return dynamicLogout(getDynamicClient());
}

/** Subscribes to a Dynamic event; returns the unsubscribe function for an effect's clean-up. */
export function onDynamic<E extends keyof DynamicEvents>(event: E, listener: DynamicEvents[E]): () => void {
  return onEvent({ event, listener }, getDynamicClient());
}
