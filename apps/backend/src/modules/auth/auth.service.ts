import { createHash, randomBytes } from "node:crypto";
import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Transactional } from "../../shared/db/database.js";
import { AppError } from "../../shared/errors/AppError.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { AuthRepositoryPort } from "./auth.repository.js";
import { AUTH_NONCE_TTL_MS, AUTH_SESSION_TTL_MS, type NonceDto, type SessionDto } from "./auth.types.js";

export interface AuthServiceOptions {
  /** "*" accepts any sign-in domain; otherwise the hosts (port included) of the allowed web origins. */
  allowedDomains: "*" | string[];
  chainIds: number[];
  now?: () => number;
  nonceTtlMs?: number;
  sessionTtlMs?: number;
}

function invalidMessage(message: string): AppError {
  return new AppError(400, "INVALID_SIWE_MESSAGE", message);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Sign-In with Ethereum (EIP-4361): proves that the caller controls the address that owns the alerts. */
export class AuthService {
  private readonly allowedDomains: "*" | string[];
  private readonly chainIds: number[];
  private readonly now: () => number;
  private readonly nonceTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(
    private readonly repo: AuthRepositoryPort,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    options: AuthServiceOptions,
  ) {
    this.allowedDomains = options.allowedDomains;
    this.chainIds = options.chainIds;
    this.now = options.now ?? Date.now;
    this.nonceTtlMs = options.nonceTtlMs ?? AUTH_NONCE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? AUTH_SESSION_TTL_MS;
  }

  createNonce(address: string): NonceDto {
    const now = this.now();
    this.repo.deleteExpiredNonces(now);
    // Not viem's generateSiweNonce(), which draws from Math.random().
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = now + this.nonceTtlMs;
    this.repo.insertNonce(nonce, address.toLowerCase(), expiresAt);
    return { nonce, expiresAt };
  }

  async verify(message: string, signature: Hex): Promise<SessionDto> {
    const now = this.now();
    const parsed = parseSiweMessage(message);
    const { domain, address, uri, version, chainId, nonce, issuedAt } = parsed;
    if (
      !domain ||
      !address ||
      !uri ||
      !version ||
      chainId === undefined ||
      !nonce ||
      !issuedAt ||
      Number.isNaN(issuedAt.getTime())
    ) {
      throw invalidMessage("Not an EIP-4361 sign-in message");
    }
    if (this.allowedDomains !== "*" && !this.allowedDomains.includes(domain)) {
      throw invalidMessage(`Sign-in message is for ${domain}, not this site`);
    }
    if (uriHost(uri) !== domain) throw invalidMessage("Sign-in message URI does not match its domain");
    if (version !== "1") throw invalidMessage("Sign-in message version must be 1");
    if (!this.chainIds.includes(chainId)) {
      throw invalidMessage(`Sign-in message chain id ${chainId} is not a Selio network`);
    }
    if (!validateSiweMessage({ message: parsed, time: new Date(now) })) {
      throw invalidMessage("Sign-in message is expired or not valid yet");
    }

    const signer = await recoverSigner(message, signature);
    if (!signer || !isAddressEqual(signer, address)) {
      throw new AppError(401, "AUTH_FAILED", `Signature does not match ${address}`);
    }

    const owner = address.toLowerCase();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.sessionTtlMs;
    this.inTransaction((tx) => {
      if (!this.repo.consumeNonce(nonce, owner, now, tx)) {
        throw new AppError(401, "AUTH_FAILED", "Unknown, used or expired sign-in nonce; request a new one");
      }
      this.repo.deleteExpiredSessions(now, tx);
      this.repo.insertSession(hashToken(token), owner, now, expiresAt, tx);
    });
    this.logger.info({ owner }, "signed in");
    return { token, owner, expiresAt };
  }

  /** The lowercase owner of a live session token, or null. */
  authenticate(token: string): string | null {
    const session = this.repo.findSession(hashToken(token));
    if (!session || session.expiresAt <= this.now()) return null;
    return session.owner;
  }
}

function uriHost(uri: string): string | null {
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

async function recoverSigner(message: string, signature: Hex): Promise<Address | null> {
  try {
    return await recoverMessageAddress({ message, signature });
  } catch {
    return null;
  }
}
