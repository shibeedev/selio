import { keccak256, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { createTransactional, type Db } from "../../shared/db/database.js";
import { McpToolError } from "../../shared/integrations/mcp/mcp.client.js";
import {
  AUSD,
  FakeChain,
  FakeDynamic,
  FakeMcp,
  MARKET,
  NOW,
  OTHER_WALLET,
  RECEIPT,
  STORAGE_KEY,
  USDC,
  VAULT,
  WALLET,
  WALLET_ID,
  WALLET_LC,
  approveCall,
  seedDelegation,
  seedGrant,
  silentLogger,
  testDb,
} from "../../testing/fakes.js";
import { createDelegationsModule, DelegationRepository } from "../delegations/index.js";
import { GrantRepository, type GrantRow } from "../grants/index.js";
import { ActionRepository } from "./actions.repository.js";
import { ExecutorService } from "./executor.service.js";
import { MESSAGES } from "./executor.types.js";
import { IntentRepository } from "./intents.repository.js";

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

let db: Db;
let chain: FakeChain;
let mcp: FakeMcp;
let dynamic: FakeDynamic;
let grants: GrantRepository;
let actions: ActionRepository;
let intents: IntentRepository;
let delegations: DelegationRepository;
let executor: ExecutorService;

beforeEach(() => {
  db = testDb();
  chain = new FakeChain();
  mcp = new FakeMcp();
  dynamic = new FakeDynamic();
  grants = new GrantRepository(db);
  actions = new ActionRepository(db);
  intents = new IntentRepository(db);
  delegations = new DelegationRepository(db);
  const delegationService = createDelegationsModule({
    repo: delegations,
    grants,
    inTransaction: createTransactional(db),
    logger: silentLogger,
    storageKey: STORAGE_KEY,
    dynamic: null,
  }).service;
  executor = new ExecutorService(
    actions,
    intents,
    grants,
    delegationService,
    chain,
    mcp,
    dynamic,
    createTransactional(db),
    silentLogger,
    { maxGas: 3_000_000n, intentTtlMs: 120_000, storageKey: STORAGE_KEY },
    () => NOW,
  );
  seedDelegation(db);
});

function plan(grant: GrantRow, triggerAt = 1) {
  return actions.insert({ grantId: grant.id, kind: grant.kind, triggerAt, utilizationBps: 9_950, status: "planned", message: null }, NOW)!;
}

async function act(grant: GrantRow, triggerAt = 1) {
  const id = plan(grant, triggerAt);
  await executor.run(id);
  return actions.find(id)!;
}

const vaultGrant = (overrides: Partial<GrantRow> = {}) => seedGrant(db, { kind: "vault", ...overrides });
const sellGrant = (overrides: Partial<GrantRow> = {}) =>
  seedGrant(db, { kind: "sell", maxSellDiscountBps: 300, payMask: 0b01, ...overrides });
const bidGrant = (overrides: Partial<GrantRow> = {}) =>
  seedGrant(db, { kind: "bid", minBidDiscountBps: 200, payIdx: 0, ...overrides });

function fundVault(balance: bigint, allowance: bigint) {
  chain.setBalance(USDC, WALLET, balance);
  chain.setAllowance(USDC, WALLET, VAULT, allowance);
}

describe("vault actions", () => {
  it("deposit min(per-action max, budget left, balance, allowance) for the wallet itself", async () => {
    const grant = vaultGrant();
    fundVault(usdc(70), usdc(250));
    const action = await act(grant);
    expect(action).toMatchObject({ status: "done", assets: usdc(70).toString(), message: null });
    const [call] = chain.sentCalls();
    expect(call).toMatchObject({ to: VAULT, chainId: 10143, nonce: 7, gas: 200_000n, functionName: "deposit" });
    expect(call!.args).toEqual([usdc(70), WALLET, (usdc(70) * 99n) / 100n]);
    expect(mcp.argsOf("build_vault_deposit")).toEqual({ network: "monad-testnet", from: WALLET, receiver: WALLET, assets: "70" });
    expect(grants.find(grant.id)?.usedTotal).toBe(usdc(70));
    expect(action.txHashes).toEqual([keccak256(chain.sent[0]!)]);
  });

  it("records an intent for the exact transaction before Dynamic signs it", async () => {
    const grant = vaultGrant({ maxPerAction: usdc(10) });
    fundVault(usdc(500), usdc(500));
    await act(grant);
    expect(dynamic.signed).toHaveLength(1);
    const signed = dynamic.signed[0]!;
    expect(signed).toMatchObject({ walletId: WALLET_ID, shareSetId: "share-set-1", walletApiKey: "test-wallet-api-key" });
    const tx = signed.transaction;
    expect(intents.findMatch({ walletId: WALLET_ID, chainId: 10143, to: VAULT, nonce: 7, dataHash: keccak256(tx.data!), now: NOW })).not.toBeNull();
  });

  it("marks the grant exhausted when the used total reaches the total budget", async () => {
    const grant = vaultGrant({ maxPerAction: usdc(100), maxTotal: usdc(100) });
    fundVault(usdc(500), usdc(500));
    expect((await act(grant)).status).toBe("done");
    expect(grants.find(grant.id)).toMatchObject({ usedTotal: usdc(100), status: "exhausted" });
    expect(await act(grant, 2)).toMatchObject({ status: "skipped", message: MESSAGES.grantInactive });
  });

  it("skips when nothing can be deposited", async () => {
    const grant = vaultGrant();
    fundVault(0n, usdc(250));
    expect(await act(grant)).toMatchObject({ status: "skipped", message: MESSAGES.nothingToDeposit });
    expect(dynamic.signed).toHaveLength(0);
  });
});

describe("sell actions", () => {
  function fundReceipts(value: bigint, allowance: bigint) {
    chain.receiptValue = value;
    chain.setAllowance(RECEIPT, WALLET, MARKET, allowance);
  }

  it("sells min(per-action max, budget left, receipt value) within the sell limit and records the fee", async () => {
    const grant = sellGrant();
    fundReceipts(usdc(150), usdc(100) * 10n ** 12n + 1n);
    const action = await act(grant);
    expect(action.status).toBe("done");
    expect(mcp.argsOf("plan_sell_now")).toEqual({ network: "monad-testnet", assets: "100", maxDiscountBps: 300, payTokens: [USDC] });
    expect(mcp.argsOf("build_sell_now")).toMatchObject({ from: WALLET, assets: "100", minFilled: "100", maxDiscountBps: 300 });
    const [call] = chain.sentCalls();
    expect(call).toMatchObject({ to: MARKET, functionName: "sellNow" });
    expect(call!.args).toEqual([usdc(100), [1n], 300, 1, usdc(100)]);
    // The bids pay 97 USDC at 3%; Selio's 0.2% fee comes out of the seller's side.
    expect(action).toMatchObject({ assets: usdc(100).toString(), fee: "194000", net: "96806000" });
    expect(grants.find(grant.id)?.usedTotal).toBe(usdc(100));
  });

  it("counts a partial fill as what the bids can absorb", async () => {
    const grant = sellGrant();
    fundReceipts(usdc(80), usdc(1_000) * 10n ** 12n);
    mcp.planFill = (assets) => assets / 2n;
    expect((await act(grant)).status).toBe("done");
    expect(mcp.argsOf("build_sell_now")).toMatchObject({ assets: "80", minFilled: "40" });
    expect(chain.sentCalls()[0]!.args).toEqual([usdc(40), [1n], 300, 1, usdc(40)]);
    expect(grants.find(grant.id)?.usedTotal).toBe(usdc(40));
  });

  it("skips without receipts, without a bid inside the limit, or with too small an allowance", async () => {
    const grant = sellGrant();
    fundReceipts(0n, usdc(1_000) * 10n ** 12n);
    expect(await act(grant, 1)).toMatchObject({ status: "skipped", message: MESSAGES.noReceipts });
    fundReceipts(usdc(100), usdc(1_000) * 10n ** 12n);
    mcp.planFill = () => 0n;
    expect(await act(grant, 2)).toMatchObject({ status: "skipped", message: MESSAGES.noBid });
    mcp.planFill = (assets) => assets;
    fundReceipts(usdc(100), usdc(100) * 10n ** 12n);
    expect(await act(grant, 3)).toMatchObject({ status: "skipped", message: MESSAGES.allowanceTooSmall });
    expect(dynamic.signed).toHaveLength(0);
  });
});

describe("bid actions", () => {
  function fundBids(balance: bigint, allowance: bigint) {
    chain.setBalance(USDC, WALLET, balance);
    chain.setAllowance(USDC, WALLET, MARKET, allowance);
  }

  it("places a bid of min(per-action max, budget left) escrowing its quote", async () => {
    const grant = bidGrant();
    fundBids(usdc(1_000), usdc(1_000));
    const action = await act(grant);
    expect(action).toMatchObject({ status: "done", bidId: "42", assets: usdc(100).toString() });
    expect(chain.sentCalls()[0]!.args).toEqual([200, 0, usdc(100), usdc(98)]);
    expect(grants.find(grant.id)?.usedTotal).toBe(usdc(100));
  });

  it("scales the bid down to what the balance and the allowance cover", async () => {
    const grant = bidGrant();
    fundBids(usdc(1_000), usdc(49));
    expect((await act(grant)).status).toBe("done");
    expect(chain.sentCalls()[0]!.args).toEqual([200, 0, usdc(50), usdc(49)]);
  });

  it("skips a bid the contract would refuse as too small", async () => {
    const grant = bidGrant();
    fundBids(usdc(1_000), usdc(49));
    chain.minEscrows.set(USDC.toLowerCase(), usdc(60));
    expect(await act(grant)).toMatchObject({ status: "skipped", message: MESSAGES.bidTooSmall });
    expect(chain.sent).toHaveLength(0);
  });

  it("cancels the standing bid first and credits its remaining maximum back to the budget", async () => {
    const grant = bidGrant({ maxTotal: usdc(120) });
    fundBids(usdc(1_000), usdc(1_000));
    expect((await act(grant, 1)).bidId).toBe("42");
    // A seller filled 70 of the bid's 100: 30 remain, with 29.4 USDC of escrow.
    chain.bids.set(42n, { bidder: WALLET, minDiscountBps: 200, payIdx: 0, maxAssets: usdc(30), escrow: usdc(29.4) });
    fundBids(0n, usdc(1_000));
    const second = await act(grant, 2);
    expect(second).toMatchObject({ status: "done", bidId: "43" });
    const calls = chain.sentCalls().slice(1);
    expect(calls.map((c) => c.functionName)).toEqual(["cancelBid", "placeBid"]);
    expect(calls[0]!.args).toEqual([42n]);
    // Budget left after the credit: 120 - (100 - 30) = 50; the refunded 29.4 USDC covers a 30 bid.
    expect(calls[1]!.args).toEqual([200, 0, usdc(30), usdc(29.4)]);
    expect(grants.find(grant.id)?.usedTotal).toBe(usdc(100));
    expect(second.txHashes).toHaveLength(2);
    expect(mcp.names().slice(-5)).toEqual([
      "get_exit_capacity",
      "build_cancel_bid",
      "simulate_transaction",
      "build_place_bid",
      "simulate_transaction",
    ]);
  });

  it("does not cancel the standing bid when the new bid would be too small", async () => {
    const grant = bidGrant();
    fundBids(usdc(1_000), usdc(1_000));
    await act(grant, 1);
    chain.bids.set(42n, { bidder: WALLET, minDiscountBps: 200, payIdx: 0, maxAssets: usdc(30), escrow: usdc(29.4) });
    fundBids(0n, usdc(1_000));
    chain.minEscrows.set(USDC.toLowerCase(), usdc(60));
    expect(await act(grant, 2)).toMatchObject({ status: "skipped", message: MESSAGES.bidTooSmall });
    expect(chain.sent).toHaveLength(1);
  });

  it("cancels the standing bid of a deleted grant", async () => {
    const grant = bidGrant();
    fundBids(usdc(1_000), usdc(1_000));
    await act(grant, 1);
    grants.setStatus(grant.id, "revoked", NOW);
    const id = actions.insert({ grantId: grant.id, kind: "cancel", triggerAt: 0, utilizationBps: null, status: "planned", message: null }, NOW)!;
    await executor.run(id);
    expect(actions.find(id)).toMatchObject({ status: "done", bidId: "42" });
    expect(chain.sentCalls()[1]).toMatchObject({ functionName: "cancelBid", args: [42n] });
    expect(mcp.names()).not.toContain("plan_sell_now");
  });
});

describe("refusals and stops", () => {
  it("aborts when a build still contains an approval, before any signing call", async () => {
    const grant = vaultGrant();
    fundVault(usdc(70), usdc(250));
    mcp.prepend = [approveCall(VAULT, usdc(70))];
    expect(await act(grant)).toMatchObject({ status: "failed", message: MESSAGES.noApprovals });
    expect(dynamic.signed).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  it("refuses a forced deposit to another receiver before any signing call", async () => {
    const grant = vaultGrant();
    fundVault(usdc(70), usdc(250));
    const forger = new FakeMcp();
    mcp.overrides.set("build_vault_deposit", (args) => forger.callTool("build_vault_deposit", { ...args, receiver: OTHER_WALLET }));
    expect(await act(grant)).toMatchObject({ status: "failed", message: "The deposit names another receiver" });
    expect(dynamic.signed).toHaveLength(0);
  });

  it("stops on a failed simulation without signing", async () => {
    const grant = vaultGrant();
    fundVault(usdc(70), usdc(250));
    mcp.simulation = { ok: false, revert: { name: "InsufficientShares" }, message: "execution reverted" };
    expect(await act(grant)).toMatchObject({
      status: "failed",
      message: "The simulation failed (InsufficientShares); nothing was signed",
    });
    expect(dynamic.signed).toHaveLength(0);
  });

  it("skips when utilization is back below the threshold", async () => {
    const grant = vaultGrant({ thresholdBps: 9_000 });
    fundVault(usdc(70), usdc(250));
    mcp.utilizationBps = 8_999;
    expect(await act(grant)).toMatchObject({ status: "skipped", message: MESSAGES.belowThreshold });
    expect(mcp.names()).toEqual(["get_exit_capacity"]);
  });

  it("skips when the delegation is no longer active", async () => {
    const grant = vaultGrant();
    delegations.end(WALLET_ID, "revoked", NOW, NOW);
    expect(await act(grant)).toMatchObject({ status: "skipped", message: MESSAGES.noAccess });
    expect(mcp.calls).toHaveLength(0);
  });

  it("marks the delegation invalid and revokes the grants when Dynamic refuses the materials", async () => {
    const grant = vaultGrant();
    const other = sellGrant();
    fundVault(usdc(70), usdc(250));
    dynamic.reject = true;
    expect(await act(grant)).toMatchObject({ status: "failed", message: MESSAGES.rejected });
    expect(delegations.find(WALLET_ID)).toMatchObject({ status: "invalid", sealedShare: null, sealedApiKey: null });
    expect(grants.find(grant.id)?.status).toBe("revoked");
    expect(grants.find(other.id)?.status).toBe("revoked");
  });

  it("refuses without enough MON for gas, above the gas limit, and fails a reverted transaction", async () => {
    const grant = vaultGrant({ maxTotal: usdc(1_000) });
    fundVault(usdc(500), usdc(500));
    chain.native = 0n;
    expect(await act(grant, 1)).toMatchObject({ status: "failed", message: MESSAGES.monForGas });
    chain.native = 10n ** 18n;
    chain.prepared = { ...chain.prepared, gas: 3_000_001n };
    expect((await act(grant, 2)).message).toBe("The transaction needs 3000001 gas, above the agent's limit of 3000000");
    chain.prepared = { ...chain.prepared, gas: 200_000n };
    chain.revertAll = true;
    const reverted = await act(grant, 3);
    expect(reverted.status).toBe("failed");
    expect(reverted.message).toMatch(/^Transaction 0x[0-9a-f]{64} reverted$/);
    expect(grants.find(grant.id)?.usedTotal).toBe(0n);
  });

  it("records the MCP tool's own text when a tool fails", async () => {
    const grant = sellGrant();
    chain.receiptValue = usdc(100);
    chain.setAllowance(RECEIPT, WALLET, MARKET, usdc(1_000) * 10n ** 12n);
    mcp.overrides.set("build_sell_now", () => {
      throw new McpToolError("Current bids can only absorb 10 USDC, below minFilled.");
    });
    expect(await act(grant)).toMatchObject({ status: "failed", message: "Current bids can only absorb 10 USDC, below minFilled." });
  });
});

describe("one action at a time per wallet", () => {
  it("serializes two grants of one wallet", async () => {
    const vault = vaultGrant();
    const bid = bidGrant();
    fundVault(usdc(70), usdc(250));
    chain.setAllowance(USDC, WALLET, MARKET, usdc(1_000));
    let release!: () => void;
    dynamic.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = plan(vault);
    const second = plan(bid);
    executor.enqueue(first);
    executor.enqueue(second);
    for (let i = 0; i < 100 && dynamic.signing === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(dynamic.signing).toBe(1);
    // The second action has not started: only the first one re-checked the chain.
    expect(mcp.names().filter((n) => n === "get_exit_capacity")).toHaveLength(1);
    release();
    await executor.idle();
    expect(dynamic.maxConcurrentSigning).toBe(1);
    expect(actions.find(first)?.status).toBe("done");
    expect(actions.find(second)?.status).toBe("done");
    expect(chain.sentCalls().map((c) => c.functionName)).toEqual(["deposit", "placeBid"]);
  });
});

describe("reconcile after a restart", () => {
  it("completes a sending action whose transaction confirmed and fails the interrupted ones", async () => {
    const grant = vaultGrant();
    const confirmed = plan(grant, 1);
    const unknown = plan(grant, 2);
    const planned = plan(grant, 3);
    const hash: Hex = `0x${"ab".repeat(32)}`;
    actions.appendHash(confirmed, hash, { assets: usdc(25).toString() }, NOW);
    actions.appendHash(unknown, `0x${"cd".repeat(32)}`, { assets: usdc(30).toString() }, NOW);
    chain.mined.set(hash, { status: "success", placedBidId: null });
    const later = plan(grant, 4);
    await executor.reconcile(planned);
    expect(actions.find(confirmed)).toMatchObject({ status: "done", message: MESSAGES.completedAfterRestart });
    expect(actions.find(unknown)).toMatchObject({ status: "failed", message: MESSAGES.interrupted });
    expect(actions.find(planned)).toMatchObject({ status: "failed", message: MESSAGES.interrupted });
    expect(actions.find(later)?.status).toBe("planned");
    expect(grants.find(grant.id)?.usedTotal).toBe(usdc(25));
  });
});

describe("pay tokens other than the underlying", () => {
  it("bids in AUSD-sim with 18-decimal escrow", async () => {
    const grant = bidGrant({ payIdx: 1 });
    chain.setBalance(AUSD, WALLET, usdc(1_000) * 10n ** 12n);
    chain.setAllowance(AUSD, WALLET, MARKET, usdc(1_000) * 10n ** 12n);
    expect((await act(grant)).status).toBe("done");
    expect(chain.sentCalls()[0]!.args).toEqual([200, 1, usdc(100), usdc(98) * 10n ** 12n]);
    expect(mcp.argsOf("build_place_bid")).toMatchObject({ payToken: AUSD, maxAssets: "100", escrow: "98" });
  });
});
