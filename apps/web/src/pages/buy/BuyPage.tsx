import { useState } from "react";
import { isAddressEqual, zeroAddress, type Address } from "viem";
import type { BorrowerPosition, SelioClient, SessionView, TokenInfo } from "@selio/sdk";
import { DemoFunds } from "../../components/DemoFunds";
import { DeploymentGate } from "../../components/DeploymentGate";
import { Notice } from "../../components/ui";
import { describeError } from "../../lib/errors";
import { formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { aaveAccount, morphoForceTerms, type AaveAccount } from "../../lib/venue";
import { useWallet } from "../../lib/wallet-context";
import { BuyPanel } from "./BuyPanel";
import { OpenAuctions } from "./OpenAuctions";

export interface BorrowerInfo {
  position: BorrowerPosition;
  collateralToken: TokenInfo | null;
  aave: AaveAccount | null;
  morphoForce: { force: boolean; penaltyWad: bigint } | null;
}

export interface OpenSessions {
  sessions: SessionView[];
  chainNow: number;
}

async function loadBorrower(selio: SelioClient, account: Address): Promise<BorrowerInfo> {
  const position = await selio.position(account);
  if (selio.deployment.venue === "aave") {
    return { position, collateralToken: null, aave: await aaveAccount(selio, account), morphoForce: null };
  }
  if (!position.market) return { position, collateralToken: null, aave: null, morphoForce: null };
  const [collateralToken, morphoForce] = await Promise.all([
    selio.token(position.market.collateralToken),
    morphoForceTerms(selio, position.market),
  ]);
  return { position, collateralToken, aave: null, morphoForce };
}

const TITLE = "Repay your debt at a discount";
const LEAD =
  "Buy a stuck depositor's receipt below face value and repay what you owe with it, in one transaction. You keep the discount; they get out.";

export function BuyPage() {
  return (
    <DeploymentGate
      head={
        <section className="page-head">
          <h1>{TITLE}</h1>
          <p className="lead">{LEAD}</p>
        </section>
      }
    >
      {({ selio, meta }) => <BuyBody selio={selio} meta={meta} />}
    </DeploymentGate>
  );
}

function BuyBody({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { info, refreshKey } = useNetwork();
  const { address } = useWallet();
  const [selected, setSelected] = useState<bigint | null>(null);
  const U = meta.underlying;

  const open = useAsync<OpenSessions>(
    async () => {
      const [sessions, block] = await Promise.all([selio.sessions(true), selio.client.getBlock()]);
      return { sessions, chainNow: Number(block.timestamp) };
    },
    [selio],
    { pollMs: 15_000, reloadKey: refreshKey },
  );
  const borrower = useAsync(() => loadBorrower(selio, address as Address), [selio, address], {
    enabled: !!address,
    pollMs: 30_000,
    reloadKey: refreshKey,
  });

  // An Aave borrower who already holds the frozen receipt (or its static wrapper) can repay with it at face value.
  const heldReceipts = useAsync(
    async () => {
      const wrapper = selio.deployment.kuruWrapper;
      const [receipt, wrapped] = await Promise.all([
        selio.balanceOf(meta.receipt.address, address as Address),
        wrapper && !isAddressEqual(wrapper, zeroAddress) ? selio.balanceOf(wrapper, address as Address) : Promise.resolve(0n),
      ]);
      return receipt + wrapped;
    },
    [selio, address],
    { enabled: !!address && meta.venue === "aave", reloadKey: refreshKey },
  );

  const debt = borrower.data?.position.debt;
  const sessions = open.data?.sessions ?? [];
  const session = sessions.find((s) => s.id === selected) ?? sessions[0];

  const debtValue = !address || borrower.error != null ? "—" : debt === undefined ? "…" : formatToken(debt, U);
  const collateral = borrower.data?.collateralToken;
  const debtSub = !address
    ? "Connect a wallet to see what you owe"
    : meta.venue === "aave"
      ? `Aave V3 · ${info.label}`
      : collateral
        ? `Morpho market ${U.symbol} / ${collateral.symbol} · ${info.label}`
        : `Morpho · ${info.label}`;

  return (
    <div className="stack-lg">
      <section className="page-head page-head--split" aria-labelledby="h-buy">
        <div className="stack-xs">
          <h1 id="h-buy">{TITLE}</h1>
          <p className="lead">{LEAD}</p>
        </div>
        <div className="debt-card card">
          <span className="small muted">Your {U.symbol} debt</span>
          <span className="debt-value mono" data-testid="buy-debt">
            {debtValue}
          </span>
          <span className="small text-2">{debtSub}</span>
        </div>
      </section>
      {borrower.error != null && <Notice tone="danger">Can't read your debt: {describeError(borrower.error)}</Notice>}
      {address && debt === 0n && (
        <div className="stack-sm">
          <DemoFunds kits={["borrower"]} compact />
        </div>
      )}
      {meta.venue === "aave" && debt !== undefined && debt > 0n && (heldReceipts.data ?? 0n) > 0n && (
        <Notice tone="info" testid="buy-atoken-hint">
          You can also repay with receipts you hold at face value through Aave's repay-with-aTokens.
        </Notice>
      )}
      <div className="split split--top">
        <OpenAuctions meta={meta} open={open} debt={debt} currentId={session?.id ?? null} onSelect={setSelected} />
        {session && <BuyPanel key={String(session.id)} selio={selio} meta={meta} session={session} borrower={borrower.data ?? null} />}
      </div>
    </div>
  );
}
