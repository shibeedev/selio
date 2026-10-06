import type { EncryptedDelegatedPayload, ServerKeyShare } from "@dynamic-labs-wallet/node";
import type { Hex, TransactionSerializableEIP1559 } from "viem";
import { AppError, ErrorCode } from "../../errors/AppError.js";

export type { EncryptedDelegatedPayload, ServerKeyShare };

export interface EncryptedDelegation {
  encryptedDelegatedShare: EncryptedDelegatedPayload;
  encryptedWalletApiKey: EncryptedDelegatedPayload;
}

export interface DelegatedSignRequest {
  walletId: string;
  shareSetId?: string;
  walletApiKey: string;
  keyShare: ServerKeyShare;
  transaction: TransactionSerializableEIP1559;
}

export interface DynamicPort {
  /** Opens the two envelopes of a `wallet.delegation.created` webhook with Selio's RSA key. */
  decryptDelegation(input: EncryptedDelegation): { keyShare: ServerKeyShare; walletApiKey: string };
  /** Signs through the MPC relay; resolves the serialized signed transaction. */
  signTransaction(request: DelegatedSignRequest): Promise<Hex>;
  /** Admin REST revoke of the developer's delegated access; true when Dynamic answered 2xx. */
  revokeDelegatedAccess(walletId: string): Promise<boolean>;
}

/** Dynamic refused the delegated materials (HTTP 401 or 403 from its delegated-access API). */
export class DelegationRejectedError extends Error {
  constructor() {
    super("Dynamic no longer accepts the delegated access");
    this.name = "DelegationRejectedError";
  }
}

export interface DynamicGatewayOptions {
  environmentId: string;
  apiToken: string;
  privateKeyPem: string;
  adminApiUrl?: string;
  revokeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const ADMIN_API_URL = "https://app.dynamic.xyz/api/v0";

/**
 * Loads the Dynamic server SDK on demand: `@dynamic-labs-wallet/node` loads a native MPC library at
 * import time, which exists for Linux and macOS only. The SDK's `revokeDelegation` only logs (1.1.35),
 * so revocation goes through the admin REST endpoint.
 */
export async function createDynamicGateway(options: DynamicGatewayOptions): Promise<DynamicPort> {
  const [evm, node] = await Promise.all([import("@dynamic-labs-wallet/node-evm"), import("@dynamic-labs-wallet/node")]);
  // errorLogging off: the SDK's own error logs can include request configs that carry API keys.
  const client = evm.createDelegatedEvmWalletClient({
    environmentId: options.environmentId,
    apiKey: options.apiToken,
    errorLogging: false,
  });
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    decryptDelegation({ encryptedDelegatedShare, encryptedWalletApiKey }) {
      try {
        const { decryptedDelegatedShare, decryptedWalletApiKey } = node.decryptDelegatedWebhookData({
          privateKeyPem: options.privateKeyPem,
          encryptedDelegatedKeyShare: encryptedDelegatedShare,
          encryptedWalletApiKey,
        });
        return { keyShare: decryptedDelegatedShare, walletApiKey: decryptedWalletApiKey };
      } catch {
        throw new AppError(502, ErrorCode.UPSTREAM_ERROR, "The delegation could not be decrypted with the agent's key");
      }
    },

    async signTransaction(request) {
      try {
        return (await evm.delegatedSignTransaction(client, request)) as Hex;
      } catch (err) {
        throw signingError(err);
      }
    },

    async revokeDelegatedAccess(walletId) {
      const url = `${options.adminApiUrl ?? ADMIN_API_URL}/environments/${encodeURIComponent(options.environmentId)}/waas/${encodeURIComponent(walletId)}/delegatedAccess`;
      try {
        const res = await fetchImpl(url, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${options.apiToken}` },
          signal: AbortSignal.timeout(options.revokeTimeoutMs ?? 5_000),
        });
        return res.status >= 200 && res.status < 300;
      } catch {
        return false;
      }
    },
  };
}

/** Turns a signing failure into DelegationRejectedError (401/403) or a 502 with a short message. */
export function signingError(err: unknown): Error {
  const status = httpStatusOf(err);
  if (status === 401 || status === 403) return new DelegationRejectedError();
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(502, ErrorCode.UPSTREAM_ERROR, `Dynamic did not sign the transaction: ${message.slice(0, 300)}`);
}

function httpStatusOf(err: unknown): number | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const e = current as { response?: { status?: unknown }; status?: unknown; message?: unknown; cause?: unknown };
    const status = e.response?.status ?? e.status;
    if (typeof status === "number") return status;
    const match = typeof e.message === "string" ? /status(?: code)? (\d{3})\b/.exec(e.message) : null;
    if (match) return Number(match[1]);
    current = e.cause;
  }
  return undefined;
}

/** JSON of a ServerKeyShare; byte fields become `{ "$bytes": <base64> }` and are revived by `parseKeyShare`. */
export function serializeKeyShare(share: ServerKeyShare): string {
  return JSON.stringify(share, (_key, value: unknown) =>
    value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value,
  );
}

export function parseKeyShare(json: string): ServerKeyShare {
  return JSON.parse(json, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const bytes = (value as { $bytes?: unknown }).$bytes;
      if (typeof bytes === "string" && Object.keys(value).length === 1) return new Uint8Array(Buffer.from(bytes, "base64"));
    }
    return value;
  }) as ServerKeyShare;
}
