import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { AGENT_NOT_CONFIGURED, AgentApiError, agentErrorFrom, createAgentApi, SIGN_IN_AGAIN } from "./agent-api";
import {
  defaultGrantForm,
  endOfLocalDay,
  expiryBounds,
  grantApproval,
  grantBody,
  hookUrl,
  localDate,
  parseGrantForm,
  revokeAgent,
  SELL_APPROVAL_SLACK_UNITS,
  type GrantForm,
} from "./agent";

// 13 Oct 2026, 10:00 local time.
const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime();
const CTX = { decimals: 6, payTokenCount: 2, now: NOW };
const form = (patch: Partial<GrantForm> = {}): GrantForm => ({ ...defaultGrantForm(NOW, 2), ...patch });
const parse = (patch: Partial<GrantForm> = {}) => parseGrantForm(form(patch), CTX);

const MARKET = "0x00000000000000000000000000000000000000a1" as Address;
const VAULT = "0x00000000000000000000000000000000000000a2" as Address;
const RECEIPT = "0x00000000000000000000000000000000000000a3" as Address;
const USDC = "0x00000000000000000000000000000000000000a4" as Address;
const AUSD = "0x00000000000000000000000000000000000000a5" as Address;
const TARGETS = { market: MARKET, selioVault: VAULT, receipt: RECEIPT, underlying: USDC, payTokens: [USDC, AUSD] };
const ID = "6f2b1c3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ALERT = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

describe("grant form", () => {
  it("accepts the defaults and converts them to the agent's units", () => {
    const { draft, errors } = parse();
    expect(errors).toEqual({});
    expect(draft).toEqual({
      kind: "sell",
      thresholdBps: 9_500,
      maxPerAction: 100_000_000n,
      maxTotal: 500_000_000n,
      expiresAt: new Date(2026, 9, 20, 23, 59, 59, 999).getTime(),
      maxSellDiscountBps: 500,
      payMask: 3,
      minBidDiscountBps: null,
      payIdx: null,
    });
    expect(parse({ kind: "bid" }).draft).toMatchObject({ minBidDiscountBps: 300, payIdx: 0, maxSellDiscountBps: null, payMask: null });
  });

  it("bounds the threshold to 0.01–100%", () => {
    expect(parse({ threshold: "0.01" }).draft?.thresholdBps).toBe(1);
    expect(parse({ threshold: "100" }).draft?.thresholdBps).toBe(10_000);
    for (const threshold of ["0", "100.01", "abc", ""]) expect(parse({ threshold }).errors.threshold).toBeDefined();
  });

  it("needs a positive per-action maximum and a total of at least that", () => {
    expect(parse({ maxPerAction: "0" }).errors.maxPerAction).toBe("Enter an amount above 0");
    expect(parse({ maxPerAction: "1.0000001" }).errors.maxPerAction).toBe("At most 6 decimals");
    expect(parse({ maxPerAction: "600", maxTotal: "500" }).errors.maxTotal).toBe(
      "The total budget must be at least the per-action maximum",
    );
    expect(parse({ maxPerAction: "500", maxTotal: "500" }).errors).toEqual({});
  });

  it("ends the grant at the end of a day from today to 29 days ahead", () => {
    expect(expiryBounds(NOW)).toEqual({ min: "2026-10-13", max: "2026-11-11" });
    expect(parse({ expires: "2026-10-13" }).errors).toEqual({});
    expect(parse({ expires: "2026-11-11" }).errors).toEqual({});
    expect(parse({ expires: "2026-11-12" }).errors.expires).toBe("Pick a day from today to 2026-11-11");
    expect(parse({ expires: "2026-10-12" }).errors.expires).toBeDefined();
    expect(endOfLocalDay("2026-02-31")).toBeNull();
    expect(parse({ expires: "next week" }).errors.expires).toBeDefined();
    expect(localDate(NOW, 7)).toBe("2026-10-20");
  });

  it("checks a sell grant's discount limit and pay tokens", () => {
    const ok = parse({ kind: "sell", sellDiscount: "50", payMask: 0b10 });
    expect(ok.draft).toMatchObject({ kind: "sell", maxSellDiscountBps: 5_000, payMask: 2, minBidDiscountBps: null, payIdx: null });
    expect(parse({ kind: "sell", sellDiscount: "50.01" }).errors.sellDiscount).toBe("Enter a discount from 0 to 50%");
    expect(parse({ kind: "sell", payMask: 0 }).errors.payMask).toBe("Pick at least one pay token");
    expect(parse({ kind: "sell", payMask: 0b100 }).errors.payMask).toBe("Pick at least one pay token");
  });

  it("checks a bid grant's discount floor and pay token", () => {
    expect(parse({ kind: "bid", bidDiscount: "0", payIdx: 1 }).draft).toMatchObject({ minBidDiscountBps: 0, payIdx: 1 });
    expect(parse({ kind: "bid", bidDiscount: "51" }).errors.bidDiscount).toBeDefined();
    expect(parse({ kind: "bid", payIdx: 2 }).errors.payIdx).toBe("Pick a pay token");
  });

  it("ignores the other kinds' fields for a vault grant", () => {
    const { draft } = parse({ kind: "vault", sellDiscount: "99", bidDiscount: "99", payIdx: 7 });
    expect(draft).toMatchObject({ kind: "vault", maxSellDiscountBps: null, payMask: null, minBidDiscountBps: null, payIdx: null });
  });
});

describe("grant request", () => {
  it("sends only the fields of the grant's kind, with base-unit strings", () => {
    const sell = grantBody(parse({ kind: "sell", sellDiscount: "4", payMask: 3 }).draft!, { id: ID, alertId: ALERT });
    expect(sell).toEqual({
      id: ID,
      network: "monad-testnet",
      alertId: ALERT,
      thresholdBps: 9_500,
      maxPerAction: "100000000",
      maxTotal: "500000000",
      expiresAt: new Date(2026, 9, 20, 23, 59, 59, 999).getTime(),
      kind: "sell",
      maxSellDiscountBps: 400,
      payMask: 3,
    });
    const bid = grantBody(parse({ kind: "bid", bidDiscount: "2.5", payIdx: 1 }).draft!, { id: ID, alertId: ALERT });
    expect(Object.keys(bid).sort()).toEqual(
      ["alertId", "expiresAt", "id", "kind", "maxPerAction", "maxTotal", "minBidDiscountBps", "network", "payIdx", "thresholdBps"].sort(),
    );
    expect(bid).toMatchObject({ kind: "bid", minBidDiscountBps: 250, payIdx: 1 });
    const vault = grantBody(parse({ kind: "vault" }).draft!, { id: ID, alertId: ALERT });
    expect(vault).not.toHaveProperty("payIdx");
    expect(vault).not.toHaveProperty("maxSellDiscountBps");
  });

  it("builds the alert webhook that triggers the grant", () => {
    expect(hookUrl("https://agent.selio.site", ID)).toBe(`https://agent.selio.site/hooks/alert/${ID}`);
    expect(hookUrl("https://agent.selio.site//", ID)).toBe(`https://agent.selio.site/hooks/alert/${ID}`);
  });
});

describe("grant approval", () => {
  const reader = () => ({
    receiptAmountFor: vi.fn(async (assets: bigint) => assets * 10n ** 12n - 7n),
    quote: vi.fn(async (assets: bigint, discountBps: number) => (assets * BigInt(10_000 - discountBps)) / 10_000n),
  });

  it("sell: the receipt shares for the whole budget to the market, plus one share unit per possible fill", async () => {
    const r = reader();
    const approval = await grantApproval({ kind: "sell", maxTotal: 500_000_000n, minBidDiscountBps: null, payIdx: null }, TARGETS, r);
    expect(r.receiptAmountFor).toHaveBeenCalledWith(500_000_000n);
    expect(approval).toEqual({ token: RECEIPT, spender: MARKET, amount: 500n * 10n ** 18n - 7n + SELL_APPROVAL_SLACK_UNITS });
  });

  it("bid: the pay token to the market, at the bid's price for the whole budget", async () => {
    const r = reader();
    const approval = await grantApproval({ kind: "bid", maxTotal: 500_000_000n, minBidDiscountBps: 300, payIdx: 1 }, TARGETS, r);
    expect(r.quote).toHaveBeenCalledWith(500_000_000n, 300, AUSD);
    expect(approval).toEqual({ token: AUSD, spender: MARKET, amount: 485_000_000n });
  });

  it("vault: exactly the budget of the underlying to the Selio Vault", async () => {
    const r = reader();
    const approval = await grantApproval({ kind: "vault", maxTotal: 500_000_000n, minBidDiscountBps: null, payIdx: null }, TARGETS, r);
    expect(approval).toEqual({ token: USDC, spender: VAULT, amount: 500_000_000n });
    expect(r.quote).not.toHaveBeenCalled();
    expect(r.receiptAmountFor).not.toHaveBeenCalled();
  });
});

describe("agent API errors", () => {
  it("asks for a new sign-in on 401", () => {
    const err = agentErrorFrom(401, { code: "UNAUTHORIZED", message: "Missing bearer token" });
    expect(err).toBeInstanceOf(AgentApiError);
    expect(err.message).toBe(SIGN_IN_AGAIN);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.status).toBe(401);
    expect(err.offline).toBe(false);
  });

  it("states the wait of a rate-limited request", () => {
    expect(agentErrorFrom(429, { code: "RATE_LIMITED", message: "Too many requests" }, "12").message).toBe(
      "The exit agent is limiting requests; try again in 12 s.",
    );
    expect(agentErrorFrom(429, {}, null).message).toBe("The exit agent is limiting requests; try again shortly.");
  });

  it("says when the agent is not configured", () => {
    expect(agentErrorFrom(503, { code: "DYNAMIC_NOT_CONFIGURED", message: "The exit agent is not configured yet" }).message).toBe(
      AGENT_NOT_CONFIGURED,
    );
  });

  it("names the fields of a validation error", () => {
    const err = agentErrorFrom(400, {
      code: "VALIDATION_ERROR",
      message: "Invalid request",
      details: [
        { path: "maxTotal", message: "must be at least maxPerAction" },
        { path: "expiresAt", message: "must be in the future" },
      ],
    });
    expect(err.message).toBe("Total budget: must be at least maxPerAction; Expiry: must be in the future");
    expect(err.details).toHaveLength(2);
  });

  it("keeps the service's own message for conflicts and other errors", () => {
    const err = agentErrorFrom(409, { code: "GRANT_EXISTS", message: "An active bid grant exists for this wallet; delete it first" });
    expect(err.code).toBe("GRANT_EXISTS");
    expect(err.message).toBe("An active bid grant exists for this wallet; delete it first");
    expect(agentErrorFrom(502, "not json").message).toBe("The exit agent answered 502.");
  });
});

describe("agent API client", () => {
  const ok = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the Dynamic JWT and JSON bodies to /agent/v1", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: ID }, 201));
    const api = createAgentApi("https://agent.selio.site/", fetchImpl as unknown as typeof fetch);
    const body = grantBody(parse({ kind: "vault" }).draft!, { id: ID, alertId: ALERT });
    expect(await api.createGrant("jwt-1", body)).toEqual({ id: ID });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://agent.selio.site/agent/v1/grants");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
    expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it("deletes a grant with the cancelBid choice and accepts 204", async () => {
    const fetchImpl = vi.fn(async () => ok(null, 204));
    const api = createAgentApi("https://agent.selio.site", fetchImpl as unknown as typeof fetch);
    await api.deleteGrant("jwt-1", ID, false);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://agent.selio.site/agent/v1/grants/${ID}?cancelBid=false`);
    expect(init.method).toBe("DELETE");
  });

  it("maps error answers and an unreachable service", async () => {
    const conflict = createAgentApi("https://agent.selio.site", (async () =>
      ok({ code: "DELEGATION_REQUIRED", message: "Allow the exit agent for this wallet first" }, 409)) as unknown as typeof fetch);
    await expect(conflict.me("jwt-1")).rejects.toMatchObject({ code: "DELEGATION_REQUIRED", status: 409 });
    const down = createAgentApi("https://agent.selio.site", (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    const err = (await down.revoke("jwt-1").catch((e: unknown) => e)) as AgentApiError;
    expect(err.offline).toBe(true);
    expect(err.message).toBe("The exit agent is unreachable at https://agent.selio.site.");
  });
});

describe("revoking the agent", () => {
  it("stops the agent first, then reshares on Dynamic and deletes the alerts", async () => {
    const order: string[] = [];
    const result = await revokeAgent({
      revoke: async () => {
        order.push("revoke");
        return { dynamicRevoked: true };
      },
      reshare: async () => {
        order.push("reshare");
      },
      deleteAlerts: async () => {
        order.push("alerts");
      },
    });
    expect(order).toEqual(["revoke", "reshare", "alerts"]);
    expect(result).toEqual({ dynamicRevoked: true, warning: null });
  });

  it("ignores a failed reshare only when Dynamic already revoked the access", async () => {
    const failing = { reshare: async () => Promise.reject(new Error("no delegation")), deleteAlerts: async () => undefined };
    expect((await revokeAgent({ ...failing, revoke: async () => ({ dynamicRevoked: true }) })).warning).toBeNull();
    expect((await revokeAgent({ ...failing, revoke: async () => ({ dynamicRevoked: false }) })).warning).toMatch(
      /Dynamic has not confirmed the revocation yet \(no delegation\)/,
    );
  });

  it("does nothing else when the agent service refuses", async () => {
    const reshare = vi.fn(async () => undefined);
    const deleteAlerts = vi.fn(async () => undefined);
    await expect(
      revokeAgent({ revoke: async () => Promise.reject(new AgentApiError(SIGN_IN_AGAIN, "UNAUTHORIZED", 401)), reshare, deleteAlerts }),
    ).rejects.toThrow(SIGN_IN_AGAIN);
    expect(reshare).not.toHaveBeenCalled();
    expect(deleteAlerts).not.toHaveBeenCalled();
  });

  it("does not fail when the alerts cannot be deleted", async () => {
    const result = await revokeAgent({
      revoke: async () => ({ dynamicRevoked: true }),
      reshare: async () => undefined,
      deleteAlerts: async () => Promise.reject(new Error("backend down")),
    });
    expect(result.warning).toBeNull();
  });
});
