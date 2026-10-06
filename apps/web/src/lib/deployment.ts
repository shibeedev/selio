import { NETWORKS, parseDeployment, type Deployment, type NetworkKey } from "@selio/sdk";

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

/** A network error, a non-OK answer or a non-JSON body (dev servers answer unknown paths with index.html) is "missing". */
export async function loadDeployment(
  key: NetworkKey,
  baseUrl: string = import.meta.env.BASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<DeploymentState> {
  let raw: unknown;
  try {
    const res = await fetchImpl(`${baseUrl}deployments/${key}.json`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return { status: "missing" };
    raw = await res.json();
  } catch {
    return { status: "missing" };
  }
  return checkDeployment(key, raw);
}
