// Handlers of the protected pool: the Earn vault (Vault V2, E.6) and its Morpho Blue markets (E.7).
import {
  indexer,
  type BorrowPosition,
  type EarnVaultState,
  type EvmOnEventContext,
  type MorphoMarket,
  type PoolEvent,
} from "envio";
import { DEPLOYMENT } from "../deployment";
import { borrowPositionId, logId } from "../lib/ids";
import { clampSub } from "../lib/math";
import {
  loadAccounts,
  loadMarket,
  loadPool,
  rowOf,
  saveRows,
  writeCapacity,
  ZERO_ADDRESS,
  type LogEvent,
  type Mutable,
  type Pool,
} from "../lib/state";

type Context = EvmOnEventContext;
type PoolEventValues = Pick<PoolEvent, "kind" | "assets"> &
  Partial<Pick<PoolEvent, "receiver" | "shares" | "penaltyAssets" | "marketId">> & { account?: string };

function poolEvent(context: Context, event: LogEvent, values: PoolEventValues): void {
  const { account, ...fields } = values;
  context.PoolEvent.set({
    id: logId(event.block.number, event.logIndex),
    account_id: account,
    receiver: undefined,
    marketId: undefined,
    shares: undefined,
    penaltyAssets: undefined,
    ...fields,
    timestamp: event.block.timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
}

/** Loads the market, the pool and the event's account, applies the change, then writes the capacity points. */
async function poolChange(context: Context, event: LogEvent, account: string | undefined, apply: (pool: Pool) => void): Promise<void> {
  const timestamp = event.block.timestamp;
  const [market, pool, accounts] = await Promise.all([
    loadMarket(context, timestamp),
    loadPool(context, timestamp),
    loadAccounts(context, account === undefined ? [] : [account], timestamp),
  ]);
  apply(pool);
  saveRows(context.Account, accounts);
  writeCapacity(context, event, market, pool);
}

const earnVaultChange = (
  context: Context,
  event: LogEvent,
  account: string | undefined,
  update: (earnVault: Mutable<EarnVaultState>) => void,
): Promise<void> =>
  poolChange(context, event, account, ({ earnVault }) => {
    update(earnVault);
    earnVault.updatedAt = event.block.timestamp;
    context.EarnVaultState.set(earnVault);
  });

const morphoChange = (
  context: Context,
  event: LogEvent,
  marketId: string,
  account: string | undefined,
  update: (market: Mutable<MorphoMarket>) => void,
): Promise<void> =>
  poolChange(context, event, account, ({ morphoMarkets }) => {
    const m = rowOf(morphoMarkets, marketId);
    update(m);
    m.updatedAt = event.block.timestamp;
    context.MorphoMarket.set(m);
  });

// ---- Earn vault (E.6) ----

indexer.onEvent({ contract: "EarnVault", event: "Deposit" }, async ({ event, context }) => {
  const { onBehalf, assets, shares } = event.params;
  poolEvent(context, event, { kind: "VAULT_DEPOSIT", account: onBehalf, assets, shares });
  await earnVaultChange(context, event, onBehalf, (earnVault) => {
    earnVault.totalAssets += assets;
    earnVault.idle += assets;
    earnVault.depositedAssets += assets;
  });
});

indexer.onEvent({ contract: "EarnVault", event: "Withdraw" }, async ({ event, context }) => {
  const { receiver, onBehalf, assets, shares } = event.params;
  poolEvent(context, event, { kind: "VAULT_WITHDRAW", account: onBehalf, receiver, assets, shares });
  await earnVaultChange(context, event, onBehalf, (earnVault) => {
    earnVault.totalAssets = clampSub(earnVault.totalAssets, assets);
    // A forced deallocation takes its penalty as a withdrawal to the vault itself: the cash stays.
    if (receiver !== DEPLOYMENT.earnVault) earnVault.idle = clampSub(earnVault.idle, assets);
    earnVault.withdrawnAssets += assets;
  });
});

indexer.onEvent({ contract: "EarnVault", event: "Allocate" }, async ({ event, context }) => {
  const { assets } = event.params;
  poolEvent(context, event, { kind: "VAULT_ALLOCATE", assets });
  await earnVaultChange(context, event, undefined, (earnVault) => {
    earnVault.idle = clampSub(earnVault.idle, assets);
  });
});

indexer.onEvent({ contract: "EarnVault", event: "Deallocate" }, async ({ event, context }) => {
  const { assets } = event.params;
  poolEvent(context, event, { kind: "VAULT_DEALLOCATE", assets });
  await earnVaultChange(context, event, undefined, (earnVault) => {
    earnVault.idle += assets;
  });
});

// Its Deallocate and its penalty Withdraw are separate logs of the same call.
indexer.onEvent({ contract: "EarnVault", event: "ForceDeallocate" }, async ({ event, context }) => {
  const { assets, onBehalf, penaltyAssets } = event.params;
  poolEvent(context, event, { kind: "VAULT_FORCE_DEALLOCATE", account: onBehalf, assets, penaltyAssets });
  await earnVaultChange(context, event, onBehalf, (earnVault) => {
    earnVault.penaltyAssets += penaltyAssets;
  });
});

indexer.onEvent({ contract: "EarnVault", event: "AccrueInterest" }, async ({ event, context }) => {
  const { newTotalAssets } = event.params;
  await earnVaultChange(context, event, undefined, (earnVault) => {
    earnVault.totalAssets = newTotalAssets;
  });
});

// E.11: receipt (Earn vault share) balances; mints and burns move the supply.
indexer.onEvent({ contract: "EarnVault", event: "Transfer" }, async ({ event, context }) => {
  const { from, to, shares } = event.params;
  const timestamp = event.block.timestamp;
  const [pool, accounts] = await Promise.all([
    loadPool(context, timestamp),
    loadAccounts(context, [from, to].filter((address) => address !== ZERO_ADDRESS), timestamp),
  ]);

  if (from !== ZERO_ADDRESS) rowOf(accounts, from).receiptShares -= shares;
  if (to !== ZERO_ADDRESS) rowOf(accounts, to).receiptShares += shares;
  saveRows(context.Account, accounts);
  if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) {
    const { earnVault } = pool;
    if (from === ZERO_ADDRESS) earnVault.totalSupply += shares;
    if (to === ZERO_ADDRESS) earnVault.totalSupply = clampSub(earnVault.totalSupply, shares);
    earnVault.updatedAt = timestamp;
    context.EarnVaultState.set(earnVault);
  }
});

// ---- Morpho Blue (E.7): only the deployment's earn and flash markets; other markets write nothing ----

const isTracked = (marketId: string): boolean =>
  marketId === DEPLOYMENT.earnMarketId || marketId === DEPLOYMENT.flashMarketId;

async function loadPosition(context: Context, marketId: string, account: string, timestamp: number): Promise<Mutable<BorrowPosition>> {
  const id = borrowPositionId(marketId, account);
  const row = await context.BorrowPosition.get(id);
  return { ...(row ?? { id, account_id: account, marketId, borrowShares: 0n, collateral: 0n }), updatedAt: timestamp };
}

/** E.7: moves a borrower's debt shares (and collateral) and writes the position. */
async function changePosition(
  context: Context,
  marketId: string,
  account: string,
  timestamp: number,
  update: (position: Mutable<BorrowPosition>) => void,
): Promise<void> {
  const position = await loadPosition(context, marketId, account, timestamp);
  update(position);
  context.BorrowPosition.set(position);
}

indexer.onEvent({ contract: "Morpho", event: "Supply" }, async ({ event, context }) => {
  const { id, onBehalf, assets, shares } = event.params;
  if (!isTracked(id)) return;
  poolEvent(context, event, { kind: "MARKET_SUPPLY", account: onBehalf, marketId: id, assets, shares });
  await morphoChange(context, event, id, onBehalf, (m) => {
    m.totalSupplyAssets += assets;
    m.totalSupplyShares += shares;
    if (onBehalf === DEPLOYMENT.adapter) m.adapterSupplyShares += shares;
  });
});

indexer.onEvent({ contract: "Morpho", event: "Withdraw" }, async ({ event, context }) => {
  const { id, onBehalf, receiver, assets, shares } = event.params;
  if (!isTracked(id)) return;
  poolEvent(context, event, { kind: "MARKET_WITHDRAW", account: onBehalf, receiver, marketId: id, assets, shares });
  await morphoChange(context, event, id, onBehalf, (m) => {
    m.totalSupplyAssets = clampSub(m.totalSupplyAssets, assets);
    m.totalSupplyShares = clampSub(m.totalSupplyShares, shares);
    if (onBehalf === DEPLOYMENT.adapter) m.adapterSupplyShares = clampSub(m.adapterSupplyShares, shares);
  });
});

indexer.onEvent({ contract: "Morpho", event: "Borrow" }, async ({ event, context }) => {
  const { id, onBehalf, receiver, assets, shares } = event.params;
  if (!isTracked(id)) return;
  poolEvent(context, event, { kind: "MARKET_BORROW", account: onBehalf, receiver, marketId: id, assets, shares });
  await changePosition(context, id, onBehalf, event.block.timestamp, (position) => {
    position.borrowShares += shares;
  });
  await morphoChange(context, event, id, onBehalf, (m) => {
    m.totalBorrowAssets += assets;
    m.totalBorrowShares += shares;
  });
});

indexer.onEvent({ contract: "Morpho", event: "Repay" }, async ({ event, context }) => {
  const { id, onBehalf, assets, shares } = event.params;
  if (!isTracked(id)) return;
  poolEvent(context, event, { kind: "MARKET_REPAY", account: onBehalf, marketId: id, assets, shares });
  await changePosition(context, id, onBehalf, event.block.timestamp, (position) => {
    position.borrowShares = clampSub(position.borrowShares, shares);
  });
  await morphoChange(context, event, id, onBehalf, (m) => {
    // `assets` may be 1 above the market's total borrow.
    m.totalBorrowAssets = clampSub(m.totalBorrowAssets, assets);
    m.totalBorrowShares = clampSub(m.totalBorrowShares, shares);
  });
});

indexer.onEvent({ contract: "Morpho", event: "Liquidate" }, async ({ event, context }) => {
  const { id, borrower, repaidAssets, repaidShares, seizedAssets, badDebtAssets, badDebtShares } = event.params;
  if (!isTracked(id)) return;
  poolEvent(context, event, { kind: "MARKET_LIQUIDATE", account: borrower, marketId: id, assets: repaidAssets, shares: repaidShares });
  await changePosition(context, id, borrower, event.block.timestamp, (position) => {
    position.borrowShares = clampSub(position.borrowShares, repaidShares + badDebtShares);
    position.collateral = clampSub(position.collateral, seizedAssets);
  });
  await morphoChange(context, event, id, borrower, (m) => {
    m.totalBorrowShares = clampSub(m.totalBorrowShares, repaidShares + badDebtShares);
    m.totalBorrowAssets = clampSub(clampSub(m.totalBorrowAssets, repaidAssets), badDebtAssets);
    m.totalSupplyAssets = clampSub(m.totalSupplyAssets, badDebtAssets);
  });
});

indexer.onEvent({ contract: "Morpho", event: "AccrueInterest" }, async ({ event, context }) => {
  const { id, interest, feeShares } = event.params;
  if (!isTracked(id)) return;
  await morphoChange(context, event, id, undefined, (m) => {
    m.totalBorrowAssets += interest;
    m.totalSupplyAssets += interest;
    m.totalSupplyShares += feeShares;
  });
});

indexer.onEvent({ contract: "Morpho", event: "SupplyCollateral" }, async ({ event, context }) => {
  const { id, onBehalf, assets } = event.params;
  if (!isTracked(id)) return;
  const timestamp = event.block.timestamp;
  saveRows(context.Account, await loadAccounts(context, [onBehalf], timestamp));
  await changePosition(context, id, onBehalf, timestamp, (position) => {
    position.collateral += assets;
  });
});

indexer.onEvent({ contract: "Morpho", event: "WithdrawCollateral" }, async ({ event, context }) => {
  const { id, onBehalf, assets } = event.params;
  if (!isTracked(id)) return;
  const timestamp = event.block.timestamp;
  saveRows(context.Account, await loadAccounts(context, [onBehalf], timestamp));
  await changePosition(context, id, onBehalf, timestamp, (position) => {
    position.collateral = clampSub(position.collateral, assets);
  });
});
