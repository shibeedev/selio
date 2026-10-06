import { createHmac, randomUUID } from "node:crypto";
import { aaveExitMarketAbi, selioVaultAbi } from "@selio/sdk";
import { encodeFunctionData, erc20Abi, getAbiItem, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createTransactional, type Db } from "../../shared/db/database.js";
import { DelegationRepository, createDelegationsModule } from "../delegations/index.js";
import { IntentRepository } from "../executor/intents.repository.js";
import { GrantRepository } from "../grants/index.js";
import { ReviewService } from "../review/index.js";
import {
  DEPLOYMENT,
  MARKET,
  NOW,
  OTHER_WALLET,
  REVIEW_SECRET,
  STORAGE_KEY,
  VAULT,
  WALLET,
  WALLET_ID,
  seedDelegation,
  silentLogger,
  testDb,
} from "../../testing/fakes.js";
import { checkAgentTx, checkReviewRequest, DENY, SELECTORS, type AgentTxContext, type PolicyGrant } from "./policy.js";

const sellGrant: PolicyGrant = {
  kind: "sell",
  status: "active",
  network: "monad-testnet",
  expiresAt: NOW + 3_600_000,
  maxPerAction: 100_000_000n,
  maxSellDiscountBps: 300,
  payMask: 0b01,
  minBidDiscountBps: null,
  payIdx: null,
};
const bidGrant: PolicyGrant = { ...sellGrant, kind: "bid", maxSellDiscountBps: null, payMask: null, minBidDiscountBps: 200, payIdx: 1 };
const vaultGrant: PolicyGrant = { ...sellGrant, kind: "vault", maxSellDiscountBps: null, payMask: null };

function ctx(overrides: Partial<AgentTxContext> = {}): AgentTxContext {
  return {
    action: overrides.grant?.kind ?? "sell",
    grant: sellGrant,
    deployment: DEPLOYMENT,
    wallet: WALLET,
    chainId: 10143,
    now: NOW,
    sized: { assets: 80_000_000n, maxAssets: 80_000_000n, escrow: 80_000_000n },
    standingBidId: 7n,
    ...overrides,
  };
}

const market = (data: Hex, value = 0n) => ({ to: MARKET, data, value });
const sellNow = (assets = 80_000_000n, maxDiscountBps = 300, payMask = 0b01, minFilled = 80_000_000n) =>
  encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "sellNow", args: [assets, [3n, 4n], maxDiscountBps, payMask, minFilled] });
const placeBid = (minDiscountBps = 200, payIdx = 1, maxAssets = 80_000_000n, escrow = 80_000_000n) =>
  encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "placeBid", args: [minDiscountBps, payIdx, maxAssets, escrow] });
const cancelBid = (bidId = 7n) => encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "cancelBid", args: [bidId] });
const deposit = (assets = 80_000_000n, receiver: Address = WALLET, minShares = 1n) =>
  encodeFunctionData({ abi: selioVaultAbi, functionName: "deposit", args: [assets, receiver, minShares] });

const reason = (r: ReturnType<typeof checkAgentTx>) => (r.ok ? "ok" : r.reason);

describe("policy selectors (K check 2)", () => {
  it("match Part 2's signatures and the SDK ABIs", () => {
    expect(SELECTORS.sellNow).toBe(toFunctionSelector("function sellNow(uint256,uint256[],uint16,uint8,uint256)"));
    expect(SELECTORS.placeBid).toBe(toFunctionSelector("function placeBid(uint16,uint8,uint256,uint256)"));
    expect(SELECTORS.cancelBid).toBe(toFunctionSelector("function cancelBid(uint256)"));
    expect(SELECTORS.deposit).toBe(toFunctionSelector("function deposit(uint256,address,uint256)"));
    expect(SELECTORS.approve).toBe(toFunctionSelector("function approve(address,uint256)"));
    expect(toFunctionSelector(getAbiItem({ abi: aaveExitMarketAbi, name: "sellNow" }))).toBe(SELECTORS.sellNow);
    expect(toFunctionSelector(getAbiItem({ abi: aaveExitMarketAbi, name: "placeBid" }))).toBe(SELECTORS.placeBid);
    expect(toFunctionSelector(getAbiItem({ abi: aaveExitMarketAbi, name: "cancelBid" }))).toBe(SELECTORS.cancelBid);
    expect(toFunctionSelector(getAbiItem({ abi: selioVaultAbi, name: "deposit" }))).toBe(SELECTORS.deposit);
  });
});

describe("checkAgentTx (E.2)", () => {
  it("requires an active, unexpired grant", () => {
    expect(reason(checkAgentTx(market(sellNow()), ctx()))).toBe("ok");
    expect(reason(checkAgentTx(market(sellNow()), ctx({ grant: { ...sellGrant, status: "revoked" } })))).toBe("The grant is not active");
    expect(reason(checkAgentTx(market(sellNow()), ctx({ now: sellGrant.expiresAt })))).toBe("The grant is not active");
  });

  it("requires the grant and the signing chain to be Monad testnet", () => {
    expect(reason(checkAgentTx(market(sellNow()), ctx({ chainId: 143 })))).toBe("The agent acts only on Monad testnet");
    expect(reason(checkAgentTx(market(sellNow()), ctx({ grant: { ...sellGrant, network: "usdt0-replay" } })))).toBe(
      "The agent acts only on Monad testnet",
    );
  });

  it("requires the Monad testnet deployment", () => {
    expect(reason(checkAgentTx(market(sellNow()), ctx({ deployment: { ...DEPLOYMENT, chainId: 143 } })))).toBe(
      "The deployment is not the Monad testnet one",
    );
    expect(reason(checkAgentTx(market(sellNow()), ctx({ deployment: { ...DEPLOYMENT, network: "vault-freeze" } })))).toBe(
      "The deployment is not the Monad testnet one",
    );
  });

  it("refuses native value", () => {
    expect(reason(checkAgentTx(market(sellNow(), 1n), ctx()))).toBe("The transaction sends native value");
  });

  describe("sellNow", () => {
    it("passes within the grant's limits and the sized amount", () => {
      const result = checkAgentTx(market(sellNow()), ctx());
      expect(result).toEqual({
        ok: true,
        call: { fn: "sellNow", assets: 80_000_000n, bidIds: [3n, 4n], maxDiscountBps: 300, payMask: 1, minFilled: 80_000_000n },
      });
    });

    it("refuses another grant kind", () => {
      expect(reason(checkAgentTx(market(sellNow()), ctx({ grant: vaultGrant, action: "sell" })))).toBe("This grant may not sell");
    });

    it("refuses more than the sized amount or the per-action maximum", () => {
      expect(reason(checkAgentTx(market(sellNow(80_000_001n)), ctx()))).toBe("The sale is larger than the agent sized it");
      const big = ctx({ sized: { assets: 200_000_000n } });
      expect(reason(checkAgentTx(market(sellNow(100_000_001n, 300, 1, 1n)), big))).toBe("The sale is larger than the agent sized it");
      expect(reason(checkAgentTx(market(sellNow()), ctx({ sized: {} })))).toBe("The sale is larger than the agent sized it");
    });

    it("refuses a discount just over the sell limit", () => {
      expect(reason(checkAgentTx(market(sellNow(80_000_000n, 300)), ctx()))).toBe("ok");
      expect(reason(checkAgentTx(market(sellNow(80_000_000n, 301)), ctx()))).toBe("The sale's discount is above your sell limit");
    });

    it("refuses pay tokens outside the grant and an empty mask", () => {
      expect(reason(checkAgentTx(market(sellNow(80_000_000n, 300, 0b11)), ctx()))).toBe("The sale accepts a pay token outside your grant");
      expect(reason(checkAgentTx(market(sellNow(80_000_000n, 300, 0)), ctx()))).toBe("The sale accepts a pay token outside your grant");
    });

    it("requires 0 < minFilled <= assets", () => {
      expect(reason(checkAgentTx(market(sellNow(80_000_000n, 300, 1, 0n)), ctx()))).toBe("The sale has no valid minimum fill");
      expect(reason(checkAgentTx(market(sellNow(70_000_000n, 300, 1, 70_000_001n)), ctx()))).toBe(
        "The sale has no valid minimum fill",
      );
    });
  });

  describe("placeBid", () => {
    const bid = ctx({ grant: bidGrant, action: "bid" });

    it("passes within the grant's bid limit, pay token and sizes", () => {
      expect(checkAgentTx(market(placeBid()), bid)).toEqual({
        ok: true,
        call: { fn: "placeBid", minDiscountBps: 200, payIdx: 1, maxAssets: 80_000_000n, escrow: 80_000_000n },
      });
    });

    it("refuses a discount just below the bid limit", () => {
      expect(reason(checkAgentTx(market(placeBid(199)), bid))).toBe("The bid's discount is below your bid limit");
    });

    it("refuses another pay token", () => {
      expect(reason(checkAgentTx(market(placeBid(200, 0)), bid))).toBe("The bid pays in a token outside your grant");
    });

    it("refuses more than the sized maximum or escrow", () => {
      expect(reason(checkAgentTx(market(placeBid(200, 1, 80_000_001n)), bid))).toBe("The bid is larger than the agent sized it");
      expect(reason(checkAgentTx(market(placeBid(200, 1, 80_000_000n, 80_000_001n)), bid))).toBe(
        "The bid escrows more than the agent sized it",
      );
    });

    it("refuses another grant kind and the clean-up of a deleted grant", () => {
      expect(reason(checkAgentTx(market(placeBid()), ctx({ action: "bid" })))).toBe("This grant may not place bids");
      expect(reason(checkAgentTx(market(placeBid()), ctx({ grant: { ...bidGrant, status: "revoked" }, action: "cancel" })))).toBe(
        "This grant may not place bids",
      );
    });
  });

  describe("cancelBid", () => {
    it("passes only for the grant's standing bid", () => {
      const bid = ctx({ grant: bidGrant, action: "bid" });
      expect(checkAgentTx(market(cancelBid(7n)), bid)).toEqual({ ok: true, call: { fn: "cancelBid", bidId: 7n } });
      expect(reason(checkAgentTx(market(cancelBid(8n)), bid))).toBe("The bid is not this grant's standing bid");
      expect(reason(checkAgentTx(market(cancelBid(7n)), { ...bid, standingBidId: null }))).toBe(
        "The bid is not this grant's standing bid",
      );
    });

    it("passes for the clean-up of a deleted bid grant, and not for other grant kinds", () => {
      const cleanup = ctx({ grant: { ...bidGrant, status: "revoked" }, action: "cancel" });
      expect(reason(checkAgentTx(market(cancelBid(7n)), cleanup))).toBe("ok");
      expect(reason(checkAgentTx(market(cancelBid(7n)), ctx({ action: "sell" })))).toBe("This grant has no bids");
    });
  });

  describe("deposit", () => {
    const vault = ctx({ grant: vaultGrant, action: "vault" });
    const toVault = (data: Hex) => ({ to: VAULT, data, value: 0n });

    it("passes with the wallet as receiver, within the sized amount, with a share minimum", () => {
      expect(checkAgentTx(toVault(deposit()), vault)).toEqual({
        ok: true,
        call: { fn: "deposit", assets: 80_000_000n, receiver: WALLET, minShares: 1n },
      });
    });

    it("refuses another receiver", () => {
      expect(reason(checkAgentTx(toVault(deposit(80_000_000n, OTHER_WALLET)), vault))).toBe("The deposit names another receiver");
    });

    it("refuses more than the sized amount and a zero share minimum", () => {
      expect(reason(checkAgentTx(toVault(deposit(80_000_001n)), vault))).toBe("The deposit is larger than the agent sized it");
      expect(reason(checkAgentTx(toVault(deposit(80_000_000n, WALLET, 0n)), vault))).toBe("The deposit has no minimum of shares");
    });

    it("refuses another grant kind", () => {
      expect(reason(checkAgentTx(toVault(deposit()), ctx({ action: "vault" })))).toBe("This grant may not deposit");
    });
  });

  describe("anything else", () => {
    const refused = "Not a Selio action the agent may sign";

    it("refuses an approval, whatever its spender", () => {
      const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARKET, 1n] });
      expect(reason(checkAgentTx({ to: DEPLOYMENT.underlying, data: approve, value: 0n }, ctx()))).toBe(refused);
      expect(reason(checkAgentTx(market(approve), ctx()))).toBe(refused);
    });

    it("refuses other market functions and a Selio selector sent to the wrong contract", () => {
      const matchBid = encodeFunctionData({ abi: aaveExitMarketAbi, functionName: "matchBid", args: [1n, 2n, 3n] });
      expect(reason(checkAgentTx(market(matchBid), ctx()))).toBe(refused);
      expect(reason(checkAgentTx({ to: VAULT, data: sellNow(), value: 0n }, ctx()))).toBe(refused);
      expect(reason(checkAgentTx(market(deposit()), ctx({ grant: vaultGrant, action: "vault" })))).toBe(refused);
      expect(reason(checkAgentTx({ to: OTHER_WALLET, data: sellNow(), value: 0n }, ctx()))).toBe(refused);
    });

    it("refuses calldata that does not decode", () => {
      expect(reason(checkAgentTx(market(`${SELECTORS.sellNow}00` as Hex), ctx()))).toBe(refused);
    });
  });
});

const evmTx = (overrides: Record<string, unknown> = {}) => ({
  to: MARKET,
  data: sellNow(),
  chainId: 10143,
  nonce: 7,
  ...overrides,
});

describe("checkReviewRequest (E.3)", () => {
  it("passes a delegated Selio call on Monad testnet to the intent check", () => {
    const check = checkReviewRequest({ shareSetType: "delegated", walletId: WALLET_ID, context: { evmTransaction: evmTx() } }, DEPLOYMENT);
    expect(check).toEqual({ verdict: "intent", walletId: WALLET_ID, to: MARKET, nonce: 7, dataHash: keccak256(sellNow()) });
    const deposits = checkReviewRequest(
      { shareSetType: "delegated", walletId: WALLET_ID, context: { evmTransaction: evmTx({ to: VAULT, data: deposit(), value: "0x0" }) } },
      DEPLOYMENT,
    );
    expect(deposits.verdict).toBe("intent");
  });

  it("denies delegated signatures on chain 143, with value, to another target or selector", () => {
    const delegated = (tx: Record<string, unknown>) =>
      checkReviewRequest({ shareSetType: "delegated", walletId: WALLET_ID, context: { evmTransaction: tx } }, DEPLOYMENT);
    expect(delegated(evmTx({ chainId: 143 }))).toEqual({ verdict: "deny", reason: DENY.chain });
    expect(delegated(evmTx({ value: "0x1" }))).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(delegated(evmTx({ to: OTHER_WALLET }))).toEqual({ verdict: "deny", reason: DENY.policy });
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [MARKET, 1n] });
    expect(delegated(evmTx({ data: approve }))).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(delegated(evmTx({ to: VAULT }))).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(delegated(evmTx({ nonce: undefined }))).toEqual({ verdict: "deny", reason: DENY.intent });
  });

  it("denies delegated messages, typed data and user operations", () => {
    const delegated = (context: Record<string, unknown>) =>
      checkReviewRequest({ shareSetType: "delegated", walletId: WALLET_ID, context }, DEPLOYMENT);
    expect(delegated({ evmMessage: "hello" })).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(delegated({ evmTypedData: { domain: { chainId: 10143 } } })).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(delegated({ evmUserOperation: { chainId: 10143 } })).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(delegated({ evmTransaction: evmTx(), evmMessage: "also" })).toEqual({ verdict: "deny", reason: DENY.policy });
    expect(checkReviewRequest({ shareSetType: "delegated", walletId: WALLET_ID, context: { evmTransaction: evmTx() } }, null)).toEqual({
      verdict: "deny",
      reason: DENY.policy,
    });
  });

  it("lets the user's own wallet sign on Monad testnet only, and messages everywhere", () => {
    const root = (context: Record<string, unknown>) => checkReviewRequest({ shareSetType: "rootUser", context }, DEPLOYMENT);
    expect(root({ evmTransaction: { to: OTHER_WALLET, chainId: 10143 } })).toEqual({ verdict: "proceed" });
    expect(root({ evmTransaction: { to: OTHER_WALLET, chainId: 143 } })).toEqual({ verdict: "deny", reason: DENY.chain });
    expect(root({ evmTypedData: { domain: { chainId: 10143 }, primaryType: "Authorization" } })).toEqual({ verdict: "proceed" });
    expect(root({ evmTypedData: { domain: { chainId: 143 }, primaryType: "Authorization" } })).toEqual({
      verdict: "deny",
      reason: DENY.chain,
    });
    expect(root({ evmTypedData: { domain: {} } })).toEqual({ verdict: "deny", reason: DENY.chain });
    expect(root({ evmMessage: "selio.site wants you to sign in" })).toEqual({ verdict: "proceed" });
    expect(root({ evmUserOperation: { chainId: 10143 } })).toEqual({ verdict: "deny", reason: DENY.policy });
  });

  it("denies the share set types Selio does not use", () => {
    for (const shareSetType of ["server", "businessAccountUser", undefined]) {
      expect(checkReviewRequest({ shareSetType, context: { evmMessage: "x" } }, DEPLOYMENT)).toEqual({ verdict: "deny", reason: DENY.policy });
    }
  });
});

describe("Transaction Review with intents", () => {
  let db: Db;
  let review: ReviewService;
  let intents: IntentRepository;
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));
  const sign = (raw: Buffer) => createHmac("sha256", REVIEW_SECRET).update(raw).digest("hex");
  const ask = (value: unknown) => {
    const raw = body(value);
    return review.review(raw, sign(raw));
  };
  const delegatedRequest = { shareSetType: "delegated", walletId: WALLET_ID, userId: "u", context: { evmTransaction: evmTx() } };

  beforeEach(() => {
    db = testDb();
    intents = new IntentRepository(db);
    const delegations = createDelegationsModule({
      repo: new DelegationRepository(db),
      grants: new GrantRepository(db),
      inTransaction: createTransactional(db),
      logger: silentLogger,
      storageKey: STORAGE_KEY,
      dynamic: null,
    });
    review = new ReviewService(intents, delegations.service, { deployment: () => DEPLOYMENT }, createTransactional(db), silentLogger, { secret: REVIEW_SECRET }, () => NOW);
    seedDelegation(db);
  });

  const recordIntent = (overrides: Partial<Parameters<IntentRepository["insert"]>[0]> = {}) =>
    intents.insert({
      id: randomUUID(),
      walletId: WALLET_ID,
      chainId: 10143,
      to: MARKET,
      dataHash: keccak256(sellNow()),
      nonce: 7,
      expiresAt: NOW + 60_000,
      ...overrides,
    });

  it("denies a delegated request without an intent", () => {
    expect(JSON.parse(ask(delegatedRequest).body)).toEqual({ proceed: false, reason: DENY.intent });
  });

  it("approves a delegated request once for a matching intent", () => {
    recordIntent();
    expect(JSON.parse(ask(delegatedRequest).body)).toEqual({ proceed: true });
    expect(JSON.parse(ask(delegatedRequest).body)).toEqual({ proceed: false, reason: DENY.intent });
  });

  it("denies an intent for other calldata, another nonce, an expired one or a revoked delegation", () => {
    recordIntent({ dataHash: keccak256(cancelBid()) });
    recordIntent({ nonce: 8 });
    recordIntent({ expiresAt: NOW });
    expect(JSON.parse(ask(delegatedRequest).body)).toEqual({ proceed: false, reason: DENY.intent });
    recordIntent();
    new DelegationRepository(db).end(WALLET_ID, "revoked", NOW, NOW);
    expect(JSON.parse(ask(delegatedRequest).body)).toEqual({ proceed: false, reason: DENY.intent });
  });

  it("answers 401 to a request whose signature does not verify", () => {
    const answer = review.review(body(delegatedRequest), "00");
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ proceed: false, reason: "Invalid signature" });
  });
});
