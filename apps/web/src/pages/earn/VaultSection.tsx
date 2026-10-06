import { useState } from "react";
import { isAddressEqual, zeroAddress } from "viem";
import { aaveExitMarketAbi, type BidView, type SelioClient } from "@selio/sdk";
import { AmountField } from "../../components/AmountField";
import { DemoFunds } from "../../components/DemoFunds";
import { Chip, Notice, Stat, SummaryRow, ToggleGroup } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { baseYieldRows, baseYieldRule, sourceInKindText, sourceState, yieldSourceOf } from "../../lib/base-yield";
import { describeError } from "../../lib/errors";
import { formatAmount, formatBps, formatShare, formatToken, parseAmountInput, toInputString } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import { receiptNoun, type MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { approvalStep, useTxRunner, type TxStep } from "../../lib/tx";
import { useWallet } from "../../lib/wallet-context";

/** A deposit reverts if it mints fewer shares than the preview minus this (same default as the MCP server). */
const DEPOSIT_SLIPPAGE_BPS = 50n;

const minSharesFor = (preview: bigint) => (preview * (10_000n - DEPOSIT_SLIPPAGE_BPS)) / 10_000n;

type Mode = "deposit" | "withdraw";

export function VaultSection({ selio, meta, bids }: { selio: SelioClient; meta: MarketMeta; bids?: BidView[] }) {
  const { refreshKey } = useNetwork();
  const wallet = useWallet();
  const address = wallet.address;
  const runner = useTxRunner();
  const upkeep = useTxRunner();
  const U = meta.underlying;
  const R = meta.receipt;
  const vaultMeta = meta.vault;
  const asset = vaultMeta.asset;
  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");
  const [skipReceipt, setSkipReceipt] = useState(false);

  const vault = useAsync(
    async () => {
      const [state, cap, balance] = await Promise.all([
        selio.vaultState(address ?? undefined),
        selio.capacity(),
        address ? selio.balanceOf(asset.address, address) : Promise.resolve(null),
      ]);
      const [inKindValue, sourceToken] = await Promise.all([
        state.redeemInKind === 0n
          ? Promise.resolve(0n)
          : selio.client.readContract({
              address: selio.market,
              abi: aaveExitMarketAbi,
              functionName: "receiptValue",
              args: [state.redeemInKind],
            }),
        isAddressEqual(state.yieldSource, zeroAddress) ? Promise.resolve(null) : selio.token(state.yieldSource),
      ]);
      return { state, cap, balance, inKindValue, sourceToken };
    },
    [selio, meta, address],
    { pollMs: 20_000, reloadKey: refreshKey },
  );
  const data = vault.data;
  const state = data?.state;
  const balance = data?.balance ?? null;

  const parsed = parseAmountInput(amount, asset.decimals);
  const amountError =
    parsed.error ??
    (parsed.value !== null && balance !== null && parsed.value > balance ? `You hold ${formatToken(balance, asset)}` : null) ??
    (parsed.value === 0n ? "Enter more than zero" : null);
  const depositAmount = parsed.value !== null && parsed.value > 0n && !amountError ? parsed.value : null;
  const preview = useAsync(() => selio.vaultPreviewDeposit(depositAmount as bigint), [selio, depositAmount], {
    enabled: depositAmount !== null,
  });

  const source = state ? yieldSourceOf(state) : null;
  const yieldRows = baseYieldRows(source, asset);
  const bid =
    state && state.bidId > 0n
      ? bids?.find((b) => b.id === state.bidId && isAddressEqual(b.bidder, vaultMeta.address))
      : undefined;
  const recoverable = state && data ? (state.heldAssets < data.cap.withdrawable ? state.heldAssets : data.cap.withdrawable) : 0n;
  const busy = runner.state.busy !== null;
  const blocked = !!wallet.writeBlockedReason;

  let chip: { tone: "open" | "tight" | "neutral"; text: string } = { tone: "neutral", text: "…" };
  if (state) {
    if (state.totalAssets === 0n) chip = { tone: "neutral", text: "Empty: waiting for its first deposit" };
    else if (state.heldAssets > 0n) chip = { tone: "tight", text: "Holding receipts: recovers as the pool refills" };
    else chip = { tone: "open", text: `Waiting: no auction has reached ${formatBps(state.minDiscountBps)} yet` };
  }

  const position = !address
    ? "connect a wallet"
    : !state
      ? "…"
      : state.shares === 0n
        ? "none yet"
        : `${formatShare(state.shares, state.totalSupply)} of the vault`;

  let depositHint: string = "Connect a wallet to deposit";
  if (balance !== null) {
    depositHint = `You hold ${formatToken(balance, asset)}`;
    if (preview.data !== undefined && state) {
      depositHint += ` · you get about ${formatAmount(preview.data, vaultMeta.decimals)} ${vaultMeta.symbol}, ${formatShare(
        preview.data,
        state.totalSupply + preview.data,
      )} of the vault; the deposit reverts below ${formatAmount(minSharesFor(preview.data), vaultMeta.decimals)}`;
    }
  }

  const depositSteps = async (): Promise<TxStep[]> => {
    if (!address || depositAmount === null) throw new Error("Enter an amount to deposit.");
    const approval = await approvalStep(selio, asset, address, vaultMeta.address, depositAmount, "so the vault can take your deposit");
    const minShares = minSharesFor(await selio.vaultPreviewDeposit(depositAmount));
    const main: TxStep = {
      label: `Deposit ${formatToken(depositAmount, asset)} into the Selio Vault`,
      tx: selio.vaultDeposit(depositAmount, address, minShares),
    };
    return approval ? [approval, main] : [main];
  };

  const withdrawSteps = async (): Promise<TxStep[]> => {
    if (!address) throw new Error("Connect a wallet first.");
    const shares = await selio.balanceOf(vaultMeta.address, address);
    if (shares === 0n) throw new Error("You have no vault shares.");
    return [
      {
        label: skipReceipt ? `Withdraw from the Selio Vault, leaving your ${R.symbol} share in it` : "Withdraw everything from the Selio Vault",
        tx: selio.vaultRedeem(shares, address, address, skipReceipt ? [R.address] : []),
      },
    ];
  };

  const recover = () =>
    upkeep.send(async () => [
      {
        label: `Redeem ${formatToken(recoverable, asset)} of held receipts for the vault`,
        tx: selio.vaultRecover(0n, recoverable),
      },
    ]);

  const deposit = async () => {
    if (await runner.send(depositSteps)) setAmount("");
  };

  const sourceInKind = state && data ? sourceInKindText(state.redeemSourceInKind, data.sourceToken) : null;
  const inKind = !state
    ? "…"
    : skipReceipt && state.redeemInKind > 0n
      ? `kept in the vault (${formatToken(state.redeemInKind, R)})`
      : state.redeemInKind === 0n
        ? `0 ${R.symbol}`
        : `${formatToken(state.redeemInKind, R)}${meta.venue === "morpho" && data ? ` (≈ ${formatToken(data.inKindValue, U)})` : ""}`;

  return (
    <>
      <section className="card card--pad stack" aria-labelledby="h-vault" data-testid="vault-section">
        <div className="panel-head">
          <h2 id="h-vault" className="h2">
            {vaultMeta.name}
          </h2>
          <Chip tone={chip.tone} testid="vault-state">
            {chip.text}
          </Chip>
        </div>
        {vault.error != null && <Notice tone="danger">Can't read the vault: {describeError(vault.error)}</Notice>}
        <div className="stats">
          <Stat label="Waiting capital" testid="vault-idle" value={state ? formatToken(state.idleAssets, asset) : "…"} />
          <Stat label="Held in stuck receipts" testid="vault-held" value={state ? formatToken(state.heldAssets, asset) : "…"} />
          <Stat label="Standing bid now" testid="vault-bid" value={!state ? "…" : bid ? formatToken(bid.capacityAssets, U) : "None"} />
          <Stat label="Total" testid="vault-total" value={state ? formatToken(state.totalAssets, asset) : "…"} />
        </div>
        {source && (
          <div className="yield-block stack-sm">
            <div className="panel-head">
              <span className="label">Base yield</span>
              <Chip tone={sourceState(source).tone} testid="vault-source-state">
                {sourceState(source).text}
              </Chip>
            </div>
            <div className="stats stats--yield">
              {yieldRows.map((row) => (
                <Stat key={row.testid} label={row.label} testid={row.testid} value={row.value} />
              ))}
            </div>
          </div>
        )}
        <ul className="rules">
          <li>
            Buys {receiptNoun(meta)} when the discount reaches <b>{formatBps(vaultMeta.minDiscountBps)}</b>, using at most{" "}
            <b>{formatBps(vaultMeta.maxShareBps, 0)}</b> of capital per receipt, so one freeze can't tie up most of the vault.
          </li>
          <li data-testid="vault-base-yield">Base yield while waiting: {state ? baseYieldRule(source, asset) : "…"}.</li>
          <li>
            Redeems receipts at full value as soon as the pool refills; anyone can trigger it. Depositors keep the discount plus the
            interest the receipts earn meanwhile.
          </li>
        </ul>
        {recoverable > 0n && (
          <div className="stack-sm">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={upkeep.state.busy !== null || blocked}
              onClick={() => void recover()}
              data-testid="vault-recover"
            >
              The pool can pay out again: redeem {formatToken(recoverable, asset)} of held receipts now
            </button>
            <TxStatus state={upkeep.state} />
          </div>
        )}
      </section>
      <section className="card card--pad card--feature stack" aria-labelledby="h-dw">
        <div className="panel-head">
          <h2 id="h-dw" className="h2-sm">
            Your position: <span data-testid="vault-position">{position}</span>
          </h2>
          <ToggleGroup<Mode>
            label="Deposit or withdraw"
            value={mode}
            onChange={(next) => {
              setMode(next);
              runner.reset();
            }}
            options={[
              { value: "deposit", label: "Deposit", testid: "vault-mode-deposit" },
              { value: "withdraw", label: "Withdraw", testid: "vault-mode-withdraw" },
            ]}
          />
        </div>
        {mode === "deposit" ? (
          <>
            <AmountField
              id="dep-amt"
              testid="vault-deposit-amount"
              label={`Deposit ${asset.symbol}`}
              value={amount}
              onChange={(v) => {
                setAmount(v);
                runner.reset();
              }}
              onMax={balance !== null && balance > 0n ? () => setAmount(toInputString(balance, asset.decimals)) : undefined}
              hint={depositHint}
              error={amount ? amountError : null}
            />
            <button
              type="button"
              className="btn btn--primary btn--lg"
              disabled={!address || depositAmount === null || busy || blocked}
              onClick={() => void deposit()}
              data-testid="vault-deposit-submit"
            >
              {busy ? "Working…" : `Deposit ${asset.symbol}`}
            </button>
            {address && balance === 0n && <DemoFunds kits={["bidder"]} compact />}
          </>
        ) : (
          <>
            <div className="summary">
              <SummaryRow label="Paid out now" testid="vault-out-now">
                {state ? formatToken(state.redeemNow, asset) : "…"}
              </SummaryRow>
              <SummaryRow label="Paid in kind (your share of held receipts)" testid="vault-out-kind">
                {inKind}
              </SummaryRow>
              {sourceInKind && (
                <SummaryRow label="Paid in kind from the yield source" testid="vault-out-source">
                  {sourceInKind}
                </SummaryRow>
              )}
            </div>
            {state && state.redeemInKind > 0n && (
              <fieldset className="fieldset">
                <legend className="label">Receipts that cannot move</legend>
                <div className="toggle-group">
                  <button
                    type="button"
                    className="toggle toggle--pill"
                    aria-pressed={skipReceipt}
                    onClick={() => {
                      setSkipReceipt((s) => !s);
                      runner.reset();
                    }}
                    data-testid="vault-skip-receipt"
                  >
                    Leave my {R.symbol} in the vault
                  </button>
                </div>
                <span className="hint">
                  Use it when {R.symbol} cannot move right now, for example while its reserve is paused. That part stays yours and can
                  be withdrawn later.
                </span>
              </fieldset>
            )}
            <button
              type="button"
              className="btn btn--primary btn--lg"
              disabled={!address || !state || state.shares === 0n || busy || blocked}
              onClick={() => void runner.send(withdrawSteps)}
              data-testid="vault-withdraw-submit"
            >
              {busy ? "Working…" : "Withdraw all · no waiting period"}
            </button>
          </>
        )}
        {address && blocked && <Notice tone="warn">{wallet.writeBlockedReason}</Notice>}
        <TxStatus state={runner.state} />
        <p className="small muted">
          Risks: capital can sit in stuck receipts until the pool refills, and receipts lose value if the pool takes bad debt. The
          per-receipt cap limits both.
        </p>
      </section>
    </>
  );
}
