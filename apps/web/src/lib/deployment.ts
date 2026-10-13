import { NETWORKS, parseDeployment, type Deployment, type NetworkKey } from "@selio/sdk";
import { apiBaseUrl } from "./env";

export type DeploymentState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "ready"; deployment: Deployment };

export function checkDeployment(key: NetworkKey, raw: unknown): DeploymentState {
  try {
    const deployment = parseDeployment(raw);
    if (deployment.network !== key) {
      return { status: "invalid", error: `the file is for "${deployment.network}", not "${key}"` };
    }
    const expected = NETWORKS[key].chain.id;
    if (deployment.chainId !== expected) {
      return { status: "invalid", error: `chain id ${deployment.chainId} does not match ${expected}` };
    }
    return { status: "ready", deployment };
  } catch (e) {
    return { status: "invalid", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The parsed JSON at `url`, or null for a network error, a non-OK answer or a non-JSON body. */
async function fetchDeployment(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * A fork's deployment comes from the backend, the one source of the forks' addresses, which change when the forks are
 * re-created every day. The live network's committed file is bundled with the app, and the backend serves it too when
 * a build has none. A network error, a non-OK answer (404 when nothing is deployed) or a non-JSON body (dev servers
 * answer unknown paths with index.html) is "missing".
 */
export async function loadDeployment(
  key: NetworkKey,
  baseUrl: string = import.meta.env.BASE_URL,
  fetchImpl: typeof fetch = fetch,
  apiUrl: string = apiBaseUrl(),
): Promise<DeploymentState> {
  const fromApi = `${apiUrl}/deployments/${key}.json`;
  let raw = await fetchDeployment(NETWORKS[key].isFork ? fromApi : `${baseUrl}deployments/${key}.json`, fetchImpl);
  if (raw === null && !NETWORKS[key].isFork) raw = await fetchDeployment(fromApi, fetchImpl);
  return raw === null ? { status: "missing" } : checkDeployment(key, raw);
}
