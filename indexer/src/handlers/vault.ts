// Handlers of the SelioVault events (Part 10 §10.1 F.4, E.10, E.11) and of its base-yield events (§0.13).
import { indexer, type EvmOnEventContext, type SelioVaultState, type VaultAction } from "envio";
import { DEPLOYMENT } from "../deployment";
import { logId } from "../lib/ids";
import { assetsPerShare, clampSub, ratioBps } from "../lib/math";
import {
  bumpVaultInterval,
  loadAccounts,
  loadVault,
  rowOf,
  saveRows,
  ZERO_ADDRESS,
  type LogEvent,
  type Mutable,
} from "../lib/state";

type ActionValues = Pick<VaultAction, "kind"> &
  Partial<Pick<VaultAction, "receiver" | "assets" | "shares" | "receiptUnits" | "strategy" | "utilizationBps">>;

/** Writes the action row, applies `update` to the vault state and writes the state and both buckets. */
async function vaultAction(
  context: EvmOnEventContext,
  event: LogEvent,
  account: string,
  values: ActionValues,
  update: (vault: Mutable<SelioVaultState>) => void,
): Promise<void> {
  const timestamp = event.block.timestamp;
  const [vault, accounts] = await Promise.all([
    loadVault(context, timestamp),
    loadAccounts(context, [account], timestamp),
  ]);

  context.VaultAction.set({
    id: logId(event.block.number, event.logIndex),
    vault_id: vault.id,
    account_id: account,
    receiver: undefined,
    assets: undefined,
    shares: undefined,
    receiptUnits: undefined,
    strategy: undefined,
    utilizationBps: undefined,
    ...values,
    timestamp,
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
  saveRows(context.Account, accounts);
  update(vault);
  vault.updatedAt = timestamp;
  context.SelioVaultState.set(vault);
  bumpVaultInterval(context, vault, timestamp);
}

indexer.onEvent({ contract: "SelioVault", event: "Deposit" }, async ({ event, context }) => {
  const { receiver, assets, shares } = event.params;
  await vaultAction(context, event, receiver, { kind: "DEPOSIT", receiver, assets, shares }, (vault) => {
    vault.depositedAssets += assets;
  });
});

indexer.onEvent({ contract: "SelioVault", event: "Redeem" }, async ({ event, context }) => {
  const { receiver, owner, shares, assets, receipts } = event.params;
  // One strategy per network: receipts[0] is the receipt paid out in kind.
  const receiptUnits = receipts[0] ?? 0n;
  await vaultAction(context, event, owner, { kind: "REDEEM", receiver, assets, shares, receiptUnits }, (vault) => {
    vault.redeemedAssets += assets;
    vault.redeemedReceiptUnits += receiptUnits;
  });
});

indexer.onEvent({ contract: "SelioVault", event: "Recovered" }, async ({ event, context }) => {
  const { strategy, caller, assets } = event.params;
  await vaultAction(context, event, caller, { kind: "RECOVER", assets, strategy: Number(strategy) }, (vault) => {
    vault.recoveredAssets += assets;
    vault.recoveryRateBps = ratioBps(vault.recoveredAssets, vault.boughtAssets);
    vault.costRecoveryBps = ratioBps(vault.recoveredAssets, vault.boughtCost);
  });
});

indexer.onEvent({ contract: "SelioVault", event: "ReceiptDeferred" }, async ({ event, context }) => {
  const { owner, strategy, amount } = event.params;
  await vaultAction(context, event, owner, { kind: "DEFER", receiptUnits: amount, strategy: Number(strategy) }, (vault) => {
    vault.deferredUnits += amount;
  });
});

indexer.onEvent({ contract: "SelioVault", event: "ReceiptClaimed" }, async ({ event, context }) => {
  const { owner, receiver, strategy, amount } = event.params;
  await vaultAction(
    context,
    event,
    owner,
    { kind: "CLAIM", receiver, receiptUnits: amount, strategy: Number(strategy) },
    (vault) => {
      vault.claimedUnits += amount;
    },
  );
});

// Base yield (§0.13): the event names no caller, so the vault's own source movements are its actions.
indexer.onEvent({ contract: "SelioVault", event: "SourceDeposited" }, async ({ event, context }) => {
  const { assets, shares } = event.params;
  await vaultAction(context, event, DEPLOYMENT.selioVault, { kind: "SOURCE_DEPOSIT", assets, shares }, (vault) => {
    vault.sourceShares += shares;
    vault.sourceDepositedAssets += assets;
  });
});

indexer.onEvent({ contract: "SelioVault", event: "SourceWithdrawn" }, async ({ event, context }) => {
  const { assets, shares } = event.params;
  await vaultAction(context, event, DEPLOYMENT.selioVault, { kind: "SOURCE_WITHDRAW", assets, shares }, (vault) => {
    vault.sourceShares = clampSub(vault.sourceShares, shares);
    vault.sourceWithdrawnAssets += assets;
  });
});

indexer.onEvent({ contract: "SelioVault", event: "SourcePulled" }, async ({ event, context }) => {
  const { assets, shares, utilizationBps } = event.params;
  const utilization = Number(utilizationBps);
  await vaultAction(
    context,
    event,
    DEPLOYMENT.selioVault,
    { kind: "SOURCE_PULL", assets, shares, utilizationBps: utilization },
    (vault) => {
      vault.sourceShares = clampSub(vault.sourceShares, shares);
      vault.sourcePulledAssets += assets;
      vault.lastPullUtilizationBps = utilization;
    },
  );
});

indexer.onEvent({ contract: "SelioVault", event: "SourceSharesInKind" }, async ({ event, context }) => {
  const { receiver, shares } = event.params;
  await vaultAction(context, event, receiver, { kind: "SOURCE_IN_KIND", receiver, shares }, (vault) => {
    vault.sourceShares = clampSub(vault.sourceShares, shares);
    vault.sourceSharesInKind += shares;
  });
});

indexer.onEvent({ contract: "SelioVault", event: "BidsRefreshed" }, async ({ event, context }) => {
  const { totalAssets, idle } = event.params;
  const timestamp = event.block.timestamp;
  const vault = await loadVault(context, timestamp);
  vault.totalAssets = totalAssets;
  vault.idle = idle;
  vault.assetsPerShare = assetsPerShare(totalAssets, vault.totalSupply);
  vault.updatedAt = timestamp;
  context.SelioVaultState.set(vault);
  bumpVaultInterval(context, vault, timestamp);
});

// E.11: slUSDC balances; mints and burns move the supply.
indexer.onEvent({ contract: "SelioVault", event: "Transfer" }, async ({ event, context }) => {
  const { from, to, value } = event.params;
  const timestamp = event.block.timestamp;
  const supplyChanges = from === ZERO_ADDRESS || to === ZERO_ADDRESS;
  const [accounts, vault] = await Promise.all([
    loadAccounts(context, [from, to].filter((address) => address !== ZERO_ADDRESS), timestamp),
    supplyChanges ? loadVault(context, timestamp) : undefined,
  ]);

  if (from !== ZERO_ADDRESS) rowOf(accounts, from).vaultShares -= value;
  if (to !== ZERO_ADDRESS) rowOf(accounts, to).vaultShares += value;
  saveRows(context.Account, accounts);
  if (vault !== undefined) {
    if (from === ZERO_ADDRESS) vault.totalSupply += value;
    if (to === ZERO_ADDRESS) vault.totalSupply = clampSub(vault.totalSupply, value);
    vault.assetsPerShare = assetsPerShare(vault.totalAssets, vault.totalSupply);
    vault.updatedAt = timestamp;
    context.SelioVaultState.set(vault);
  }
});
