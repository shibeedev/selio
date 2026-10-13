import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withReadBudget } from "./budget.js";
import { createChainLayer, type SelioChain } from "./chain.js";
import type { ChainLayerOptions } from "./config.js";
import { errorMessage } from "./errors.js";
import * as build from "./tools/build.js";
import type { ToolContext } from "./tools/common.js";
import * as history from "./tools/history.js";
import * as read from "./tools/read.js";
import * as sim from "./tools/simulate.js";

export { createChainLayer, RpcChainLayer, findRevertData } from "./chain.js";
export type { CallOutcome, ChainReads, SelioChain, MarketSdk, NetworkHandle, NetworkListing } from "./chain.js";
export { loadMcpConfig, defaultDeploymentsDir, envSuffix } from "./config.js";
export type { ChainLayerOptions } from "./config.js";
export { ToolError } from "./errors.js";
export { decodeRevert } from "./revert.js";

export const SERVER_NAME = "selio";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Selio is an exit market for high-utilization lending pools on Monad (Aave V3 aMonUSDT0, Morpho USDC Earn vault shares).
Depositors stuck in a ~100%-utilized pool sell their deposit receipts to same-asset borrowers (who repay debt at a discount in the same transaction), to escrowed limit bids, or to the Selio Vault.
This server only reads on-chain data, simulates, and builds UNSIGNED transactions. It never holds keys and never signs: hand every transaction to the user's wallet.
Amounts are human decimal strings in token units (for example "1.5"); outputs give both raw base units and human values. Discounts are basis points (100 = 1%).
Typical flows: stuck depositor -> get_exit_capacity, plan_sell_now, build_sell_now or build_open_session. Borrower -> get_borrower_position, list_sessions, quote_purchase, build_buy_and_repay or build_buy_with_collateral. Discount buyer -> list_bids, build_place_bid or build_vault_deposit. Always simulate_transaction before sending.
Past activity (fills with fees, auctions, bid depth, exit capacity over time, Selio Vault recoveries, a wallet's history) -> get_history; it covers monad-testnet only and is for display, so re-read current state on-chain before acting.`;

const READ = { readOnlyHint: true, openWorldHint: true } as const;

export interface SelioMcpOptions extends ChainLayerOptions {
  /** Pre-built chain layer (shared across requests, or a fake in tests). Overrides deploymentsDir/rpcUrls. */
  chain?: SelioChain;
  /** Most chain reads one Streamable HTTP request may make, across all its tool calls. Unset: no bound. */
  maxReadsPerRequest?: number;
  /** GraphQL endpoint of the Selio event index (Envio HyperIndex) that get_history reads. Unset: get_history is refused. */
  indexerUrl?: string;
}

const toText = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);

/** Runs a tool body and converts its result or failure into an MCP tool result. */
export async function runTool(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: toText(await fn()) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: errorMessage(err) }] };
  }
}

/** Creates an MCP server exposing Selio's read, plan, build and simulate tools. */
export function createSelioMcpServer(options: SelioMcpOptions = {}): McpServer {
  const ctx: ToolContext = { chain: options.chain ?? createChainLayer(options), indexerUrl: options.indexerUrl };
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_networks",
    {
      title: "List networks",
      description:
        "Lists the Selio networks (live testnet and scenario forks), their lending venue (Aave or Morpho), chain id and whether contracts are deployed. Call this first to pick the `network` argument for every other tool.",
      inputSchema: read.listNetworksShape,
      annotations: READ,
    },
    () => runTool(() => read.listNetworks(ctx)),
  );
  server.registerTool(
    "get_exit_capacity",
    {
      title: "Get exit capacity",
      description:
        "Live exit capacity of a pool from on-chain data: what can be withdrawn right now, utilization, how much same-asset debt borrowers could repay by buying receipts, receipts on sale in sessions, and escrowed bid capacity at 1/3/5/10/20% discount. Use it to judge how frozen a pool is and how much a stuck depositor can exit, at what discount.",
      inputSchema: read.getExitCapacityShape,
      annotations: READ,
    },
    (args) => runTool(() => read.getExitCapacity(ctx, args)),
  );
  server.registerTool(
    "list_sessions",
    {
      title: "List sale sessions",
      description:
        "Lists Dutch-auction sale sessions (open ones by default): seller, current discount (it only rises over time), schedule, receipt value left and accepted payment tokens. Borrowers use this to find receipts to buy and repay debt cheaply; sellers use it to track their sessions.",
      inputSchema: read.listSessionsShape,
      annotations: READ,
    },
    (args) => runTool(() => read.listSessions(ctx, args)),
  );
  server.registerTool(
    "list_bids",
    {
      title: "List limit bids",
      description:
        "Lists active escrowed limit bids (including the Selio Vault's), best price for sellers first, one page at a time: minimum discount, payment token, escrow and how much receipt value each bid still buys. Pass nextCursor to read the next page. Use it to see the order book a seller can sell into right now.",
      inputSchema: read.listBidsShape,
      annotations: READ,
    },
    (args) => runTool(() => read.listBids(ctx, args)),
  );
  server.registerTool(
    "quote_purchase",
    {
      title: "Quote a purchase",
      description:
        "Prices buying `assets` of receipt face value from a session at its current discount, paid in a given token, and shows the saving versus face value, Selio's 0.2% fee and what the seller receives after it (the buyer pays the price). Use before build_buy_and_repay / build_buy_with_collateral.",
      inputSchema: read.quotePurchaseShape,
      annotations: READ,
    },
    (args) => runTool(() => read.quotePurchase(ctx, args)),
  );
  server.registerTool(
    "get_borrower_position",
    {
      title: "Get borrower position",
      description:
        "Shows an address's same-asset debt on the market's lending pool and its health (Aave health factor, or Morpho max-borrow over debt), plus Morpho collateral. Use it to check whether an address can buy receipts to repay debt and how much.",
      inputSchema: read.getBorrowerPositionShape,
      annotations: READ,
    },
    (args) => runTool(() => read.getBorrowerPosition(ctx, args)),
  );
  server.registerTool(
    "plan_sell_now",
    {
      title: "Plan an instant sale",
      description:
        "Plans selling `assets` of receipts immediately into escrowed limit bids up to `maxDiscountBps`, best price first: which bids fill, average discount, proceeds, Selio's 0.2% fee and the net amount the seller receives per payment token. Read-only; use build_sell_now to get the transaction.",
      inputSchema: read.planSellNowShape,
      annotations: READ,
    },
    (args) => runTool(() => read.planSellNow(ctx, args)),
  );
  server.registerTool(
    "build_open_session",
    {
      title: "Build: open a sale session",
      description:
        "Builds the unsigned transactions for a stuck depositor to escrow receipts and open a Dutch-auction session whose discount rises from startBps by stepBps every stepIntervalSeconds up to capBps. Includes the receipt approval when needed. Shows Selio's 0.2% fee and what the seller receives at the start and at the cap. Use when bids cannot absorb the sale or the seller wants borrowers to compete.",
      inputSchema: build.buildOpenSessionShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildOpenSession(ctx, args)),
  );
  server.registerTool(
    "build_withdraw_unsold",
    {
      title: "Build: withdraw unsold receipts",
      description:
        "Builds the unsigned transaction for a seller to take back all unsold receipts of a session, effective immediately. Sold parts are unaffected.",
      inputSchema: build.buildWithdrawUnsoldShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildWithdrawUnsold(ctx, args)),
  );
  server.registerTool(
    "build_buy_and_repay",
    {
      title: "Build: buy receipts and repay debt (wallet)",
      description:
        "Builds the unsigned transactions for a borrower to buy receipts from a session at the current discount, paying from the wallet; the market repays the borrower's same-asset debt by the face value in the same transaction. Includes the pay-token approval when the allowance of `from` is too low.",
      inputSchema: build.buildBuyAndRepayShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildBuyAndRepay(ctx, args)),
  );
  server.registerTool(
    "build_buy_with_collateral",
    {
      title: "Build: buy receipts paying with freed collateral (flash mode)",
      description:
        "Flash mode for borrowers without cash: the market repays the debt first and pays the seller with collateral the repayment frees. Aave: returns the aToken approval (when needed) and the purchase transaction. Morpho: first returns two EIP-712 typed-data messages the buyer must sign (no transaction); call again with `authorization` holding both signatures to get the transaction. Selio never signs.",
      inputSchema: build.buildBuyWithCollateralShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildBuyWithCollateral(ctx, args)),
  );
  server.registerTool(
    "build_place_bid",
    {
      title: "Build: place a limit bid",
      description:
        "Builds the unsigned transactions to escrow a payment token and place a limit bid that buys receipts at a discount of at least minDiscountBps, up to maxAssets of face value. Includes the approval when needed. Use for discount buyers who want to stand ready before or during a freeze.",
      inputSchema: build.buildPlaceBidShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildPlaceBid(ctx, args)),
  );
  server.registerTool(
    "build_cancel_bid",
    {
      title: "Build: cancel a limit bid",
      description:
        "Builds the unsigned transaction for a bidder to cancel a limit bid and get the unused escrow back immediately.",
      inputSchema: build.buildCancelBidShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildCancelBid(ctx, args)),
  );
  server.registerTool(
    "build_sell_now",
    {
      title: "Build: sell receipts now",
      description:
        "Builds the unsigned transactions for a stuck depositor to sell receipts immediately into escrowed limit bids up to maxDiscountBps, best price first, receiving payment minus Selio's 0.2% fee in the same transaction. Includes the receipt approval when needed. Fails if no bid qualifies.",
      inputSchema: build.buildSellNowShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildSellNow(ctx, args)),
  );
  server.registerTool(
    "build_vault_deposit",
    {
      title: "Build: deposit into the Selio Vault",
      description:
        "Builds the unsigned transactions to deposit the vault asset into the Selio Vault, a pooled buyer that escrows limit bids by fixed rules and earns the discount plus receipt interest. Includes the approval when needed.",
      inputSchema: build.buildVaultDepositShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildVaultDeposit(ctx, args)),
  );
  server.registerTool(
    "build_vault_redeem",
    {
      title: "Build: redeem Selio Vault shares",
      description:
        "Builds the unsigned transaction to redeem Selio Vault shares at any time: idle capital is returned in the vault asset, receipts the vault holds are returned in kind. Shows a preview of both.",
      inputSchema: build.buildVaultRedeemShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildVaultRedeem(ctx, args)),
  );
  server.registerTool(
    "build_route_repay_with_frozen_collateral",
    {
      title: "Build: repay Aave debt with frozen collateral",
      description:
        "Aave only. Fallback for a borrower whose collateral is the frozen receipt (for example aMonUSDT0) and cannot be withdrawn: sells that collateral into escrowed bids (the borrower pays Selio's 0.2% fee as the seller) and repays debt in a pay token, in one transaction. Refuses when the pool can pay the collateral out directly, and simulates the route before returning it.",
      inputSchema: build.buildRouteRepayShape,
      annotations: READ,
    },
    (args) => runTool(() => build.buildRouteRepayWithFrozenCollateral(ctx, args)),
  );
  server.registerTool(
    "simulate_transaction",
    {
      title: "Simulate a transaction",
      description:
        "Dry-runs a transaction (eth_call) from `from` against the current chain state and returns ok, or the decoded revert reason (Selio custom errors, Error(string) or Panic). Use on every built transaction right before asking the wallet to send it.",
      inputSchema: sim.simulateTransactionShape,
      annotations: READ,
    },
    (args) => runTool(() => sim.simulateTransaction(ctx, args)),
  );
  server.registerTool(
    "get_history",
    {
      title: "Get market history",
      description:
        "Past activity of the Selio market on monad-testnet, from the Selio event index (Envio HyperIndex): fills with the 0.2% fee and the seller's net, Dutch auctions with their discount schedule and fills, limit bids and how they filled, exit capacity and bid depth over time, the Selio Vault's purchases and recoveries, or one wallet's sales, bids and totals. For display and research only: before building any transaction, read current state with get_exit_capacity, list_sessions, list_bids or quote_purchase.",
      inputSchema: history.getHistoryShape,
      annotations: READ,
    },
    (args) => runTool(() => history.getHistory(ctx, args)),
  );

  return server;
}

/**
 * Serves one Streamable HTTP request in stateless mode: a fresh server and transport per request, JSON responses.
 * `body` is the already-parsed JSON body.
 */
export async function handleStreamableHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  options: SelioMcpOptions,
): Promise<void> {
  if (req.method !== "POST") {
    // Stateless mode has no server-initiated stream or session to delete; 405 tells MCP clients so.
    res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This MCP endpoint is stateless; send JSON-RPC requests with POST" },
        id: null,
      }),
    );
    return;
  }
  const server = createSelioMcpServer(options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await withReadBudget(options.maxReadsPerRequest, () => transport.handleRequest(req, res, body));
}
