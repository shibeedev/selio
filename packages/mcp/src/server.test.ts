import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createSelioMcpServer } from "./server.js";
import { AAVE_DEPLOYMENT, fakeChain, fakeNetwork } from "./testing/fakes.js";

const TOOLS: Record<string, string[] | undefined> = {
  list_networks: undefined,
  get_exit_capacity: ["network"],
  list_sessions: ["network"],
  list_bids: ["network"],
  quote_purchase: ["network", "sessionId", "assets", "payToken"],
  get_borrower_position: ["network", "address"],
  plan_sell_now: ["network", "assets", "maxDiscountBps"],
  build_open_session: ["network", "assets", "startBps", "stepBps", "stepIntervalSeconds", "capBps", "durationSeconds"],
  build_withdraw_unsold: ["network", "sessionId"],
  build_buy_and_repay: ["network", "sessionId", "assets", "payToken", "from"],
  build_buy_with_collateral: ["network", "sessionId", "assets", "payToken", "from"],
  build_place_bid: ["network", "minDiscountBps", "payToken", "maxAssets", "escrow"],
  build_cancel_bid: ["network", "bidId"],
  build_sell_now: ["network", "assets", "maxDiscountBps"],
  build_vault_deposit: ["network", "assets"],
  build_vault_redeem: ["network", "from"],
  build_route_repay_with_frozen_collateral: [
    "network",
    "from",
    "collateralAmount",
    "repayToken",
    "repayAmount",
    "maxDiscountBps",
  ],
  simulate_transaction: ["network", "from", "to", "data"],
  get_history: ["network", "view"],
};

const INSTRUCTIONS = `Selio is an exit market for frozen lending pools on Monad (Aave V3 aMonUSDT0, Morpho USDC Earn vault shares).
Depositors stuck in a ~100%-utilized pool sell their deposit receipts to same-asset borrowers (who repay debt at a discount in the same transaction), to escrowed limit bids, or to the Selio Vault.
This server only reads on-chain data, simulates, and builds UNSIGNED transactions. It never holds keys and never signs: hand every transaction to the user's wallet.
Amounts are human decimal strings in token units (for example "1.5"); outputs give both raw base units and human values. Discounts are basis points (100 = 1%).
Typical flows: stuck depositor -> get_exit_capacity, plan_sell_now, build_sell_now or build_open_session. Borrower -> get_borrower_position, list_sessions, quote_purchase, build_buy_and_repay or build_buy_with_collateral. Discount buyer -> list_bids, build_place_bid or build_vault_deposit. Always simulate_transaction before sending.
Past activity (fills with fees, auctions, bid depth, exit capacity over time, Selio Vault recoveries, a wallet's history) -> get_history; it covers monad-testnet only and is for display, so re-read current state on-chain before acting.`;

async function connect() {
  const net = fakeNetwork(AAVE_DEPLOYMENT);
  vi.spyOn(net.sdk, "capacity").mockResolvedValue({
    withdrawable: 0n,
    supplied: 1_000_000n,
    utilizationBps: 10_000,
    debtorCapacity: 1_000_000n,
    sessionAssets: 0n,
  });
  vi.spyOn(net.sdk, "bidCapacityAt").mockResolvedValue(0n);
  const server = createSelioMcpServer({ chain: fakeChain({ "usdt0-replay": net.handle }) });
  const client = new Client({ name: "selio-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[])[0]?.text ?? "";

describe("MCP server", () => {
  it("introduces itself as selio with its instructions", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toEqual({ name: "selio", version: "0.1.0" });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it("lists the 19 tools, each described, read-only annotated and with its required inputs", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name)).toEqual(Object.keys(TOOLS));
    expect([...tools.map((t) => t.name)].sort()).toEqual(Object.keys(TOOLS).sort());
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
      expect(tool.execution).toEqual({ taskSupport: "forbidden" });
      expect(tool.inputSchema.required).toEqual(TOOLS[tool.name]);
      if (tool.name !== "list_networks") expect(tool.inputSchema.required).toContain("network");
    }
  });

  it("never asks for key material", async () => {
    const { tools } = await (await connect()).listTools();
    const names = tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {}));
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) expect(name).not.toMatch(/private|mnemonic|seed|secret|password/i);
  });

  it("answers tool calls with JSON text, and failures as tool errors", async () => {
    const client = await connect();
    const capacity = await client.callTool({ name: "get_exit_capacity", arguments: { network: "usdt0-replay" } });
    expect(capacity.isError).toBeFalsy();
    expect(JSON.parse(textOf(capacity)).utilization.percent).toBe("100.00%");

    const badNetwork = await client.callTool({ name: "get_exit_capacity", arguments: { network: "ethereum" } });
    expect(badNetwork.isError).toBe(true);
    expect(textOf(badNetwork)).toMatch(/Invalid enum value.*at network/);

    const undeployed = await client.callTool({ name: "get_exit_capacity", arguments: { network: "monad-testnet" } });
    expect(undeployed.isError).toBe(true);
    expect(textOf(undeployed)).toMatch(/No Selio deployment found for monad-testnet/);
  });

  it("refuses get_history on a scenario fork", async () => {
    const fork = await (await connect()).callTool({
      name: "get_history",
      arguments: { network: "usdt0-replay", view: "fills" },
    });
    expect(fork.isError).toBe(true);
    expect(textOf(fork)).toBe(
      "History is indexed on monad-testnet only. usdt0-replay and vault-freeze are scenario forks reset every day; use list_sessions, list_bids and get_exit_capacity for their current state.",
    );
  });
});
