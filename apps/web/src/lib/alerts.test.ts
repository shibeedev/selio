import { recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alertSession,
  buildSignInMessage,
  clearAlertSession,
  formatMaskedWebhook,
  signInForAlerts,
  SIGN_IN_STATEMENT,
  webhookInputError,
} from "./alerts";
import { ApiError, createAlert, deleteAlert, getAlertEvents, listAlerts } from "./api";

const account = privateKeyToAccount(generatePrivateKey());
const NONCE = "0123456789abcdef0123456789abcdef";
const where = { domain: "selio.site", uri: "https://selio.site" };

interface Call {
  url: string;
  init: RequestInit;
}

/** Stubs fetch with a backend that answers sign-in calls and records every request. */
function stubBackend(verify: (body: { message: string; signature: Hex }) => unknown, status = 200) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/api/auth/nonce")) return Response.json({ nonce: NONCE, expiresAt: Date.now() + 60_000 });
      if (url.endsWith("/api/auth/verify")) return Response.json(verify(JSON.parse(String(init.body))), { status });
      return Response.json({ alerts: [], events: [], id: "a1" }, { status });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alert sign-in", () => {
  it("builds an EIP-4361 message that parses back field for field", () => {
    const issuedAt = new Date("2026-10-13T10:00:00.000Z");
    const message = buildSignInMessage({ address: account.address, chainId: 10143, nonce: NONCE, ...where, issuedAt });
    expect(message.split("\n")[0]).toBe("selio.site wants you to sign in with your Ethereum account:");
    expect(message).toContain(SIGN_IN_STATEMENT);
    const parsed = parseSiweMessage(message);
    expect(parsed).toMatchObject({
      domain: "selio.site",
      address: account.address,
      statement: SIGN_IN_STATEMENT,
      uri: "https://selio.site",
      version: "1",
      chainId: 10143,
      nonce: NONCE,
    });
    expect(parsed.issuedAt?.toISOString()).toBe(issuedAt.toISOString());
  });

  it("keeps a session per owner, whatever the letter case, until it expires or is cleared", async () => {
    const expiresAt = Date.now() + 60_000;
    stubBackend(() => ({ token: "t", owner: account.address.toLowerCase(), expiresAt }));
    await signInForAlerts({ address: account.address, chainId: 143, sign: (m) => account.signMessage({ message: m }), ...where });
    expect(alertSession(account.address)?.token).toBe("t");
    expect(alertSession(account.address.toUpperCase().replace("0X", "0x"))?.token).toBe("t");
    expect(alertSession(account.address, expiresAt)).toBeNull();
    clearAlertSession(account.address);
    expect(alertSession(account.address)).toBeNull();
  });

  it("stores the session the backend issues for a signature that recovers to the wallet", async () => {
    let posted: { message: string; signature: Hex } | null = null;
    stubBackend((body) => {
      posted = body;
      return { token: "t0k", owner: account.address.toLowerCase(), expiresAt: Date.now() + 60_000 };
    });
    const session = await signInForAlerts({
      address: account.address,
      chainId: 10143,
      sign: (m) => account.signMessage({ message: m }),
      ...where,
    });
    expect(session.token).toBe("t0k");
    expect(alertSession(account.address)?.token).toBe("t0k");
    const sent = posted as unknown as { message: string; signature: Hex };
    expect(await recoverMessageAddress({ message: sent.message, signature: sent.signature })).toBe(account.address);
    clearAlertSession(account.address);
  });
});

describe("authenticated alert calls", () => {
  it("send the session token, the owner on delete, and surface a 401", async () => {
    const calls = stubBackend(() => ({}));
    await createAlert({ network: "monad-testnet", thresholdBps: 9_500, owner: account.address }, "t");
    await listAlerts(account.address, "t");
    await deleteAlert("a1", account.address, "t");
    await getAlertEvents(account.address, "t");
    expect(calls).toHaveLength(4);
    for (const call of calls) expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect(calls[2]?.url).toContain(`/api/alerts/a1?owner=${account.address}`);
    expect(calls[2]?.init.method).toBe("DELETE");

    stubBackend(() => ({}), 401);
    const failure = await listAlerts(account.address, "stale").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
  });
});

describe("webhook input", () => {
  it("applies the backend's rule before submitting", () => {
    expect(webhookInputError("")).toBeNull();
    expect(webhookInputError("https://hooks.example.com/x")).toBeNull();
    expect(webhookInputError("http://localhost:9999/hook")).toBeNull();
    const tooLong = `https://a.io/${"x".repeat(2_036)}`;
    expect(tooLong).toHaveLength(2_049);
    for (const bad of ["http://example.com/hook", "http://127.0.0.1:9999/hook", "ftp://example.com", tooLong]) {
      expect(webhookInputError(bad), bad).toBe("Enter an https:// URL");
    }
  });

  it("shows a saved webhook as its host and last four characters", () => {
    expect(formatMaskedWebhook({ host: "hooks.example.com", last4: "abcd" })).toBe("hooks.example.com …abcd");
  });
});
