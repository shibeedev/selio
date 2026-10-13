import { formatBps, formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { useNetwork } from "../../lib/network-context";
import { hrefFor } from "../../lib/router";

const MCP_CONFIG = JSON.stringify(
  { mcpServers: { selio: { command: "node", args: ["<path-to-selio>/packages/mcp/dist/index.js"] } } },
  null,
  2,
);

const MCP_CHIPS = ["Read exit capacity", "List auctions and bids", "Quote and plan sales", "Simulate", "Build unsigned transactions"];

const AGENT_USES = [
  "A curator's agent sells early when a pool's exit capacity starts to drop.",
  "A borrower's agent repays at a discount with a flash loan the moment a pool freezes.",
  "A treasury agent moves idle funds into the Selio Vault to earn while it waits.",
];

/** Four ways to use Selio from an app or an AI agent, pointed at the selected network. */
export function DevelopersPage() {
  const { key, info, deployment, selio, meta, refreshKey } = useNetwork();
  const capacity = useAsync(() => selio!.capacity(), [selio], { enabled: selio !== null, reloadKey: refreshKey });

  const reads = [
    deployment.status === "ready"
      ? `// Exit market on ${info.label}: ${deployment.deployment.market}`
      : `// Selio is not deployed on ${info.label} yet`,
    "capacity() → (withdrawable, supplied, utilizationBps,",
    "              debtorCapacity, sessionAssets)",
    "bidCapacityAt(uint16 discountBps) → uint256  // escrowed bids only",
    "activeBidIdsPage(offset, limit) → uint256[]   bids(id) → (bidder, minDiscountBps, …)",
    "nextSessionId()   sessions(id)   discountOf(id)   remainingAssets(id)",
    ...(deployment.status === "ready" && deployment.deployment.kuruSellRouter
      ? [
          "",
          `// Kuru market ${deployment.deployment.kuruMarket}, through KuruSellRouter ${deployment.deployment.kuruSellRouter}`,
          "exitCapacity() → the pool's capacity: the risk data behind every receipt on Kuru",
          "facePerBase() → underlying per whole base unit, to read Kuru prices as discounts",
        ]
      : []),
  ].join("\n");

  const sdk = [
    'import { createPublicClient, http } from "viem";',
    'import { SelioClient, NETWORKS, parseDeployment } from "@selio/sdk";',
    "",
    `const net = NETWORKS["${key}"];`,
    "const deployment = parseDeployment(await (await fetch(DEPLOYMENT_URL)).json());",
    "const selio = new SelioClient(deployment, createPublicClient({ chain: net.chain, transport: http(net.defaultRpcUrl) }));",
    "",
    "const cap = await selio.capacity();",
    "const plan = await selio.planSellNow(amount, 500, payMask); // best bids up to 5% off",
    "const tx = selio.sellNow(plan, 500, payMask, plan.filledAssets); // unsigned",
    "await selio.simulate(tx, account); // eth_call before any signature",
    "// also: openSession, buyAndRepay(WithCollateral), placeBid, cancelBid,",
    "// vaultDeposit, vaultRedeem, routeRepayWithFrozenCollateral, routeSwapFrozenCollateral",
  ].join("\n");

  const webhook = JSON.stringify(
    { network: key, utilizationBps: capacity.data?.utilizationBps ?? 9977, thresholdBps: 9500, at: 1791763200000 },
    null,
    2,
  );

  const live = capacity.data && meta.data ? capacity.data : null;

  return (
    <div className="stack-lg">
      <section className="page-head" aria-labelledby="h-dev">
        <h1 id="h-dev">Developers</h1>
        <p className="lead">
          Four ways to use Selio from your app or AI agent, on every network in the selector. Currently pointing at {info.label}.
        </p>
      </section>
      <div className="dev-grid">
        <section className="card card--pad stack-sm" aria-labelledby="h-reads">
          <div className="dev-head">
            <span className="mono muted">01</span>
            <h2 id="h-reads" className="h2-sm">
              On-chain reads
            </h2>
          </div>
          <p className="text-2">
            Exit capacity, open auctions and limit bids, straight from the contracts. No permission, no fee. Vaults and curators call
            it before they allocate, to price freeze risk.
          </p>
          <pre className="code" data-testid="dev-reads">
            {reads}
          </pre>
          {live && meta.data && (
            <p className="small muted" data-testid="dev-live-capacity">
              Live on {info.label}: {formatToken(live.withdrawable, meta.data.underlying)} withdrawable of{" "}
              {formatToken(live.supplied, meta.data.underlying)}, utilization {formatBps(live.utilizationBps)}.
            </p>
          )}
        </section>
        <section className="card card--pad stack-sm" aria-labelledby="h-sdk">
          <div className="dev-head">
            <span className="mono muted">02</span>
            <h2 id="h-sdk" className="h2-sm">
              SDK
            </h2>
          </div>
          <p className="text-2">
            Sell, buy and repay (wallet or flash loan), place limit bids, use the Selio Vault and call the frozen-collateral route.
            Every write comes back as an unsigned transaction, so position managers and aggregators keep their users' way out when
            a pool freezes without handing over keys.
          </p>
          <pre className="code" data-testid="dev-sdk">
            {sdk}
          </pre>
        </section>
        <section className="card card--pad card--dark stack-sm" aria-labelledby="h-mcp">
          <div className="dev-head">
            <span className="mono">03</span>
            <h2 id="h-mcp" className="h2-sm">
              MCP server for AI agents
            </h2>
          </div>
          <p className="dark-callout">
            <b>Reads, simulates and builds unsigned transactions.</b> It never holds keys and never signs; your wallet or your
            agent's wallet does.
          </p>
          <div className="chips">
            {MCP_CHIPS.map((chip) => (
              <span key={chip} className="dark-chip">
                {chip}
              </span>
            ))}
          </div>
          <pre className="code code--dark" data-testid="dev-mcp">
            {MCP_CONFIG}
          </pre>
          <ul className="dark-list">
            {AGENT_USES.map((use) => (
              <li key={use}>{use}</li>
            ))}
          </ul>
        </section>
        <section className="card card--pad stack-sm" aria-labelledby="h-hook">
          <div className="dev-head">
            <span className="mono muted">04</span>
            <h2 id="h-hook" className="h2-sm">
              Webhook alerts
            </h2>
          </div>
          <p className="text-2">
            Get a POST when a pool's utilization rises above your threshold, so your bot can sell, bid or rebalance before the exits
            fill up. Set it up in Exit capacity on the Overview page.
          </p>
          <pre className="code" data-testid="dev-webhook">
            {webhook}
          </pre>
          <a className="link-strong self-start" href={hrefFor("overview")}>
            Set an alert
          </a>
        </section>
      </div>
    </div>
  );
}
