import { createHash } from "node:crypto";
import type { Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { beforeEach, describe, expect, it } from "vitest";
import { createTransactional, type Db } from "../../shared/db/database.js";
import { OTHER_SIGNER, SIGNER, silentLogger, testDb } from "../../testing/fakes.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { AUTH_NONCE_TTL_MS, AUTH_SESSION_TTL_MS } from "./auth.types.js";

const T0 = 1_791_000_000_000;

describe("AuthService", () => {
  let db: Db;
  let clock: number;
  let service: AuthService;

  beforeEach(() => {
    db = testDb();
    clock = T0;
    service = new AuthService(new AuthRepository(db), createTransactional(db), silentLogger, {
      allowedDomains: ["app.example"],
      chainIds: [10143, 143],
      now: () => clock,
    });
  });

  function message(nonce: string, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}): string {
    return createSiweMessage({
      address: SIGNER.address,
      chainId: 10143,
      domain: "app.example",
      nonce,
      uri: "https://app.example",
      version: "1",
      issuedAt: new Date(clock),
      ...overrides,
    });
  }

  async function signed(text: string, account = SIGNER): Promise<Hex> {
    return account.signMessage({ message: text });
  }

  it("issues random single-use nonces bound to an address", () => {
    const first = service.createNonce(SIGNER.address);
    const second = service.createNonce(SIGNER.address);
    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(first.expiresAt).toBe(T0 + AUTH_NONCE_TTL_MS);
    expect(second.nonce).not.toBe(first.nonce);
    const row = db.prepare("SELECT address FROM auth_nonces WHERE nonce = ?").get(first.nonce);
    expect(row?.address).toBe(SIGNER.address.toLowerCase());
  });

  it("signs in with an EIP-4361 message signed by the address", async () => {
    const { nonce } = service.createNonce(SIGNER.address);
    const text = message(nonce);
    const session = await service.verify(text, await signed(text));
    expect(session.token).toHaveLength(43);
    expect(session.owner).toBe(SIGNER.address.toLowerCase());
    expect(session.expiresAt).toBe(T0 + AUTH_SESSION_TTL_MS);
    expect(service.authenticate(session.token)).toBe(SIGNER.address.toLowerCase());
    const stored = db.prepare("SELECT token_hash FROM auth_sessions").all().map((r) => r.token_hash);
    expect(stored).toEqual([createHash("sha256").update(session.token).digest("hex")]);
    expect(stored).not.toContain(session.token);
  });

  it("rejects messages for another domain, URI, version or chain", async () => {
    const invalid = { statusCode: 400, code: "INVALID_SIWE_MESSAGE" };
    const cases = [
      message(service.createNonce(SIGNER.address).nonce, { domain: "evil.example", uri: "https://evil.example" }),
      message(service.createNonce(SIGNER.address).nonce, { uri: "https://evil.example/login" }),
      message(service.createNonce(SIGNER.address).nonce).replace("Version: 1", "Version: 2"),
      message(service.createNonce(SIGNER.address).nonce, { chainId: 1 }),
      message(service.createNonce(SIGNER.address).nonce, { expirationTime: new Date(clock - 1) }),
      "Please sign this to log in",
    ];
    const messages = [
      "Sign-in message is for evil.example, not this site",
      "Sign-in message URI does not match its domain",
      "Sign-in message version must be 1",
      "Sign-in message chain id 1 is not a Selio network",
      "Sign-in message is expired or not valid yet",
      "Not an EIP-4361 sign-in message",
    ];
    for (const [i, text] of cases.entries()) {
      await expect(service.verify(text, await signed(text))).rejects.toMatchObject({ ...invalid, message: messages[i] });
    }
  });

  it("rejects a wrong signer, a used nonce and an expired nonce", async () => {
    const failed = { statusCode: 401, code: "AUTH_FAILED" };

    const wrongSigner = message(service.createNonce(SIGNER.address).nonce);
    await expect(service.verify(wrongSigner, await signed(wrongSigner, OTHER_SIGNER))).rejects.toMatchObject({
      ...failed,
      message: `Signature does not match ${SIGNER.address}`,
    });

    const once = message(service.createNonce(SIGNER.address).nonce);
    const signature = await signed(once);
    await service.verify(once, signature);
    await expect(service.verify(once, signature)).rejects.toMatchObject({
      ...failed,
      message: "Unknown, used or expired sign-in nonce; request a new one",
    });

    const stale = message(service.createNonce(SIGNER.address).nonce);
    clock += AUTH_NONCE_TTL_MS;
    await expect(service.verify(stale, await signed(stale))).rejects.toMatchObject(failed);

    const foreign = message(service.createNonce(OTHER_SIGNER.address).nonce);
    await expect(service.verify(foreign, await signed(foreign))).rejects.toMatchObject(failed);
  });

  it("expires sessions", async () => {
    const text = message(service.createNonce(SIGNER.address).nonce);
    const { token, expiresAt } = await service.verify(text, await signed(text));
    clock = expiresAt - 1;
    expect(service.authenticate(token)).toBe(SIGNER.address.toLowerCase());
    clock = expiresAt;
    expect(service.authenticate(token)).toBeNull();
    clock = expiresAt + 60_000;
    expect(service.authenticate(token)).toBeNull();
    expect(service.authenticate("not-a-token")).toBeNull();
  });
});
