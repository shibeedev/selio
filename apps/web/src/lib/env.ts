import { NETWORKS, type NetworkKey } from "@selio/sdk";

export type EnvLike = Record<string, unknown>;

/** Backend used by `vite dev` and tests when VITE_API_URL is not set. */
export const DEV_API_URL = "http://127.0.0.1:8787";
/** Backend used by a production build when VITE_API_URL is not set. */
export const PROD_API_URL = "https://api.selio.site";

export function rpcEnvName(key: NetworkKey): string {
  return `VITE_RPC_${key.toUpperCase().replace(/-/g, "_")}`;
}

function envString(env: EnvLike, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolveRpcUrl(key: NetworkKey, env: EnvLike): string {
  return envString(env, rpcEnvName(key)) ?? NETWORKS[key].defaultRpcUrl;
}

export function resolveApiUrl(env: EnvLike): string {
  const url = envString(env, "VITE_API_URL") ?? (env.PROD === true ? PROD_API_URL : DEV_API_URL);
  return url.replace(/\/+$/, "");
}

export function rpcUrlFor(key: NetworkKey): string {
  return resolveRpcUrl(key, import.meta.env);
}

export function apiBaseUrl(): string {
  return resolveApiUrl(import.meta.env);
}
