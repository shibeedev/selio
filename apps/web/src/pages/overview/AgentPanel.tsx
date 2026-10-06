import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Address, Hex } from "viem";
import type { SelioClient, TokenInfo } from "@selio/sdk";
import { Chip } from "../../components/ui";
import { TxStatus } from "../../components/TxStatus";
import { OPEN_WALLET_MENU_EVENT } from "../../components/WalletMenu";
import {
  agentConfigured,
  agentToken,
  DELEGATION_POLL_MS,
  DELEGATION_WAIT_MS,
  defaultGrantForm,
  expiryBounds,
  grantApproval,
  grantBody,
  hookUrl,
  KIND_LABEL,
  parseGrantForm,
  revokeAgentFor,
  useAgentMe,
  type GrantForm,
} from "../../lib/agent";
import type { ActionDto, GrantDto, GrantKind } from "../../lib/agent-api";
import { alertSession, signInForAlerts } from "../../lib/alerts";
import { createAlert, deleteAlert } from "../../lib/api";
import { describeError } from "../../lib/errors";
import { feeLabel } from "../../lib/fees";
import { formatBps, formatToken } from "../../lib/format";
import { useAsync } from "../../lib/hooks";
import type { MarketMeta } from "../../lib/market";
import { useNetwork } from "../../lib/network-context";
import { explorerTxUrl } from "../../lib/networks";
import { maskIncludes } from "../../lib/paymask";
import { approvalStep, useTxRunner, type TxStep } from "../../lib/tx";
import { loadDynamic, useWallet } from "../../lib/wallet-context";

const CONSENT =
  "The exit agent can sign for this wallet without asking you each time, but only for these Selio actions on Monad Testnet: sell your receipts into bids, keep one limit bid, or deposit into the Selio Vault, within the limits you set next. It cannot send your funds anywhere else. You can revoke it at any time, and it stops at once.";

const ACTION_LABEL: Record<ActionDto["kind"], string> = {
  sell: "Sold into bids",
  bid: "Placed a limit bid",
  vault: "Deposited into the Selio Vault",
  cancel: "Cancelled the agent's bid",
};

const ACTION_STATUS: Record<ActionDto["status"], string> = {
  planned: "Planned",
  sending: "Sending",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const GRANT_STATUS: Record<GrantDto["status"], string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired",
  exhausted: "Budget used up",
};

const when = (ms: number) => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Status = { ok: boolean; text: string } | null;

/** Allowances a grant of each kind uses: receipts or a pay token to the market, the underlying to the vault. */
function allowanceTargets(grants: readonly GrantDto[], meta: MarketMeta, selio: SelioClient) {
  const out = new Map<string, { token: TokenInfo; spender: Address; label: string }>();
  for (const g of grants) {
    const token = g.kind === "sell" ? meta.receipt : g.kind === "bid" ? meta.payTokens[g.payIdx ?? -1] : meta.underlying;
    if (!token) continue;
    const spender = g.kind === "vault" ? meta.vault.address : selio.market;
    out.set(`${token.address}:${spender}`, {
      token,
      spender,
      label: g.kind === "vault" ? "the Selio Vault" : "the market",
    });
  }
  return [...out.values()];
}

/** The exit agent on Overview: delegation, grants with their limits, recent actions and revoke (Monad Testnet only). */
export function AgentPanel({ selio, meta }: { selio: SelioClient; meta: MarketMeta }) {
  const { info, key, refresh } = useNetwork();
  const wallet = useWallet();
  const runner = useTxRunner();
  const U = meta.underlying;
  const configured = agentConfigured();
  const account = wallet.embeddedAccount;
  const address = wallet.address;
  const active = configured && key === "monad-testnet" && account !== null;
  const me = useAgentMe({ enabled: active, pollMs: 15_000 });
  const [form, setForm] = useState<GrantForm>(() => defaultGrantForm(Date.now(), meta.payTokens.length));
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"delegate" | "save" | "revoke" | "delete" | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [cancelBid, setCancelBid] = useState<Record<string, boolean>>({});
  const [zeroTargets, setZeroTargets] = useState<ReturnType<typeof allowanceTargets>>([]);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const leftover = useAsync(
    async () => {
      const amounts = await Promise.all(
        zeroTargets.map((t) => selio.allowance(t.token.address, address as Address, t.spender)),
      );
      return zeroTargets.filter((_, i) => (amounts[i] ?? 0n) > 0n);
    },
    [zeroTargets, selio, address],
    { enabled: zeroTargets.length > 0 && address !== null, reloadKey: runner.state.outcome },
  );

  const head = (
    <>
      <h3 id="h-agent" className="h3">
        Exit agent
      </h3>
      <p className="small muted">
        Let Selio act for you when this pool's exit capacity drops: sell early into bids, keep a limit bid, or add to the Selio
        Vault, only within the limits you set. Revoke it at any time.
      </p>
    </>
  );
  const statusLine = status && (
    <p className={status.ok ? "small text-good" : "small text-bad"} role="status" data-testid="agent-status">
      {status.text}
    </p>
  );

  if (!configured) {
    return (
      <div className="panel stack-sm" aria-labelledby="h-agent" data-testid="agent-panel" data-state="off">
        {head}
        <p className="small" data-testid="agent-not-configured">
          The exit agent is not configured on this deployment yet: this build has no Dynamic environment or agent service.
          Everything else on Selio works without it.
        </p>
      </div>
    );
  }
  if (info.isFork) {
    return (
      <div className="panel stack-sm" aria-labelledby="h-agent" data-testid="agent-panel" data-state="fork">
        {head}
        <p className="small">The exit agent runs on Monad Testnet only.</p>
      </div>
    );
  }
  if (!account || !address) {
    return (
      <div className="panel stack-sm" aria-labelledby="h-agent" data-testid="agent-panel" data-state="signin">
        {head}
        <p className="small">Sign in with email or a passkey to use the exit agent.</p>
        <button
          type="button"
          className="btn btn--secondary btn--small self-start"
          onClick={() => {
            window.scrollTo({ top: 0 });
            window.dispatchEvent(new Event(OPEN_WALLET_MENU_EVENT));
          }}
          data-testid="agent-signin"
        >
          Sign in with email or a passkey
        </button>
      </div>
    );
  }

  const data = me.data;
  const delegationOn = data?.delegation?.status === "active";
  const grants = data?.grants ?? [];
  const activeKinds = new Set(grants.filter((g) => g.status === "active").map((g) => g.kind));
  const parsed = parseGrantForm(form, { decimals: U.decimals, payTokenCount: meta.payTokens.length, now: Date.now() });
  const errors = parsed.errors;
  const kindTaken = activeKinds.has(form.kind);
  const set = (patch: Partial<GrantForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    runner.reset();
  };
  const fail = (e: unknown) => setStatus({ ok: false, text: describeError(e) });

  const delegate = async () => {
    setBusy("delegate");
    setStatus(null);
    try {
      const api = me.api;
      if (!api) return;
      await (await loadDynamic()).grantDelegation(account);
      // Dynamic sends the delegated share to the agent in a webhook; wait until the agent has it.
      const until = Date.now() + DELEGATION_WAIT_MS;
      while (alive.current && Date.now() < until) {
        const current = await api.me(await agentToken());
        if (current.delegation?.status === "active") {
          me.reload();
          setStatus({ ok: true, text: "The exit agent is allowed. Now choose what it may do and its limits." });
          return;
        }
        await sleep(DELEGATION_POLL_MS);
      }
      if (alive.current) setStatus({ ok: false, text: "Dynamic has not confirmed the delegation yet. Try again in a minute." });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const draft = parsed.draft;
    const api = me.api;
    if (!draft || !api || kindTaken || busy) return;
    setBusy("save");
    setStatus(null);
    const grantId = crypto.randomUUID();
    let alert: { id: string; token: string } | null = null;
    try {
      const approval = await grantApproval(
        draft,
        {
          market: selio.market,
          selioVault: meta.vault.address,
          receipt: meta.receipt.address,
          underlying: U.address,
          payTokens: meta.payTokens.map((t) => t.address),
        },
        selio,
      );
      const token =
        draft.kind === "sell" ? meta.receipt : draft.kind === "bid" ? meta.payTokens[draft.payIdx ?? 0] : meta.underlying;
      if (!token) throw new Error("Pick a pay token.");
      const why =
        draft.kind === "sell"
          ? `so the exit agent can sell up to ${formatToken(draft.maxTotal, U)} of receipts into bids`
          : draft.kind === "bid"
            ? `so the exit agent can escrow a limit bid for up to ${formatToken(draft.maxTotal, U)}`
            : `so the exit agent can deposit up to ${formatToken(draft.maxTotal, U)} into the Selio Vault`;
      const step: TxStep | null = await approvalStep(selio, token, address, approval.spender, approval.amount, why);
      if (step && !(await runner.send(async () => [step]))) return;
      const session = alertSession(address) ?? (await signInForAlerts({ address, chainId: info.chain.id, sign: wallet.signMessage }));
      const alertId = await createAlert(
        { network: "monad-testnet", thresholdBps: draft.thresholdBps, owner: address, webhookUrl: hookUrl(api.baseUrl, grantId) },
        session.token,
      );
      alert = { id: alertId, token: session.token };
      await api.createGrant(await agentToken(), grantBody(draft, { id: grantId, alertId }));
      setStatus({
        ok: true,
        text: `Saved. The agent acts when ${info.label} crosses ${formatBps(draft.thresholdBps)} utilization, within these limits.`,
      });
      me.reload();
    } catch (err) {
      // The alert would only trigger a grant that does not exist.
      if (alert) void deleteAlert(alert.id, address, alert.token).catch(() => undefined);
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (g: GrantDto) => {
    const api = me.api;
    if (!api) return;
    setBusy("delete");
    setStatus(null);
    try {
      await api.deleteGrant(await agentToken(), g.id, g.kind === "bid" ? (cancelBid[g.id] ?? true) : false);
      const session = alertSession(address);
      if (session) await deleteAlert(g.alertId, address, session.token).catch(() => undefined);
      me.reload();
      setStatus({ ok: true, text: `Deleted. The agent no longer acts on that ${KIND_LABEL[g.kind].toLowerCase()} grant.` });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    const api = me.api;
    if (!api) return;
    setBusy("revoke");
    setStatus(null);
    try {
      const result = await revokeAgentFor({ api, account, owner: address, grants });
      setZeroTargets(allowanceTargets(grants, meta, selio));
      setStatus(result.warning ? { ok: false, text: result.warning } : { ok: true, text: "The exit agent is revoked and has stopped." });
      me.reload();
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const zeroAllowances = (targets: ReturnType<typeof allowanceTargets>) =>
    runner.send(async () =>
      targets.map((t) => ({
        label: `Set the ${t.token.symbol} allowance of ${t.label} to zero`,
        tx: selio.approve(t.token.address, t.spender, 0n),
        approval: true,
      })),
    );

  const { min, max } = expiryBounds(Date.now());
  const working = busy !== null || runner.state.busy !== null;

  return (
    <form
      className="panel stack-sm"
      aria-labelledby="h-agent"
      data-testid="agent-panel"
      data-state={delegationOn ? "on" : data ? "consent" : me.error != null ? "error" : "loading"}
      onSubmit={(e) => void save(e)}
    >
      {head}
      {me.data === undefined && me.error == null && <p className="small muted loading">Reading the exit agent…</p>}
      {me.error != null && (
        <div className="stack-sm">
          <p className="small text-bad" role="status" data-testid="agent-status">
            {describeError(me.error)}
          </p>
          <button type="button" className="btn btn--secondary btn--small self-start" onClick={me.reload}>
            Try again
          </button>
        </div>
      )}
      {data && !delegationOn && (
        <>
          {data.delegation?.status === "invalid" && (
            <p className="small text-warn">Dynamic no longer accepts the agent's access to this wallet. Allow it again to use it.</p>
          )}
          <p className="small">{CONSENT}</p>
          <label className="row-sm small">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="agent-consent" />
            I understand
          </label>
          <button
            type="button"
            className="btn btn--primary self-start"
            disabled={!consent || working}
            onClick={() => void delegate()}
            data-testid="agent-delegate"
          >
            {busy === "delegate" ? "Waiting for Dynamic…" : "Allow the exit agent"}
          </button>
        </>
      )}
      {data && delegationOn && (
        <>
          <span className="label">What the agent may do</span>
          <div className="toggle-group" role="group" aria-label="Agent action" data-testid="agent-grant-kind">
            {(Object.keys(KIND_LABEL) as GrantKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className="toggle toggle--pill"
                aria-pressed={form.kind === k}
                onClick={() => set({ kind: k })}
                data-testid={`agent-grant-kind-${k}`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <label className="label" htmlFor="agent-th">
            Act when utilization rises above
          </label>
          <div className="input-row input-row--narrow">
            <input
              id="agent-th"
              className="input input--mono"
              inputMode="decimal"
              value={form.threshold}
              onChange={(e) => set({ threshold: e.target.value })}
              aria-invalid={errors.threshold ? true : undefined}
              data-testid="agent-threshold"
            />
            <span>%</span>
          </div>
          {errors.threshold && <span className="hint text-bad">{errors.threshold}</span>}
          <label className="label" htmlFor="agent-per">
            At most per action ({U.symbol} face value)
          </label>
          <input
            id="agent-per"
            className="input input--mono"
            inputMode="decimal"
            value={form.maxPerAction}
            onChange={(e) => set({ maxPerAction: e.target.value })}
            aria-invalid={errors.maxPerAction ? true : undefined}
            data-testid="agent-max-per-action"
          />
          {errors.maxPerAction && <span className="hint text-bad">{errors.maxPerAction}</span>}
          <label className="label" htmlFor="agent-total">
            Total budget ({U.symbol} face value)
          </label>
          <input
            id="agent-total"
            className="input input--mono"
            inputMode="decimal"
            value={form.maxTotal}
            onChange={(e) => set({ maxTotal: e.target.value })}
            aria-invalid={errors.maxTotal ? true : undefined}
            data-testid="agent-max-total"
          />
          <span className={errors.maxTotal ? "hint text-bad" : "hint"}>
            {errors.maxTotal ?? "The agent stops once it has used this much; a cancelled bid gives its unfilled part back."}
          </span>
          <label className="label" htmlFor="agent-exp">
            Last day the agent may act
          </label>
          <input
            id="agent-exp"
            className="input input--mono"
            type="date"
            min={min}
            max={max}
            value={form.expires}
            onChange={(e) => set({ expires: e.target.value })}
            aria-invalid={errors.expires ? true : undefined}
            data-testid="agent-expires"
          />
          {errors.expires && <span className="hint text-bad">{errors.expires}</span>}
          {form.kind === "sell" && (
            <>
              <label className="label" htmlFor="agent-sell-disc">
                Sell only at a discount of at most (%)
              </label>
              <input
                id="agent-sell-disc"
                className="input input--mono"
                inputMode="decimal"
                value={form.sellDiscount}
                onChange={(e) => set({ sellDiscount: e.target.value })}
                aria-invalid={errors.sellDiscount ? true : undefined}
                data-testid="agent-sell-discount"
              />
              <span className={errors.sellDiscount ? "hint text-bad" : "hint"}>
                {errors.sellDiscount ?? `${feeLabel(meta.feeBps)} of each payment comes on top of the discount.`}
              </span>
              <span className="label">Accept payment in</span>
              <div className="toggle-group" role="group" aria-label="Pay tokens">
                {meta.payTokens.map((t, i) => (
                  <button
                    key={t.address}
                    type="button"
                    className="toggle toggle--pill"
                    aria-pressed={maskIncludes(form.payMask, i)}
                    onClick={() => set({ payMask: form.payMask ^ (1 << i) })}
                    data-testid={`agent-pay-${t.symbol}`}
                  >
                    {t.symbol}
                  </button>
                ))}
              </div>
              {errors.payMask && <span className="hint text-bad">{errors.payMask}</span>}
            </>
          )}
          {form.kind === "bid" && (
            <>
              <label className="label" htmlFor="agent-bid-disc">
                Bid only at a discount of at least (%)
              </label>
              <input
                id="agent-bid-disc"
                className="input input--mono"
                inputMode="decimal"
                value={form.bidDiscount}
                onChange={(e) => set({ bidDiscount: e.target.value })}
                aria-invalid={errors.bidDiscount ? true : undefined}
                data-testid="agent-bid-discount"
              />
              {errors.bidDiscount && <span className="hint text-bad">{errors.bidDiscount}</span>}
              <span className="label">Escrow in</span>
              <div className="toggle-group" role="group" aria-label="Pay token">
                {meta.payTokens.map((t, i) => (
                  <button
                    key={t.address}
                    type="button"
                    className="toggle toggle--pill"
                    aria-pressed={form.payIdx === i}
                    onClick={() => set({ payIdx: i })}
                    data-testid={`agent-bid-pay-${t.symbol}`}
                  >
                    {t.symbol}
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="hint">
            Saving asks you to sign an approval of exactly this budget, then a sign-in for its alert. The agent never signs an
            approval itself, so it can never spend more.
          </span>
          {kindTaken && (
            <span className="hint text-bad">You already have an active grant of this kind. Delete it below to make a new one.</span>
          )}
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!parsed.draft || kindTaken || working}
            data-testid="agent-grant-save"
          >
            {busy === "save" ? "Saving…" : "Save and approve"}
          </button>
          {grants.length > 0 && (
            <ul className="alert-list" aria-label="Grants">
              {grants.map((g) => (
                <GrantRow
                  key={g.id}
                  grant={g}
                  meta={meta}
                  cancelBid={cancelBid[g.id] ?? true}
                  onCancelBid={(v) => setCancelBid((c) => ({ ...c, [g.id]: v }))}
                  onDelete={() => void remove(g)}
                  disabled={working}
                />
              ))}
            </ul>
          )}
          {data.actions.length > 0 && (
            <>
              <span className="label">Recent actions</span>
              <ul className="alert-list" aria-label="Agent actions">
                {data.actions.map((a) => (
                  <ActionRow key={a.id} action={a} meta={meta} txUrl={(hash) => explorerTxUrl(info, hash as Hex)} />
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="btn btn--secondary btn--small self-start"
            disabled={working}
            onClick={() => void revoke()}
            data-testid="agent-revoke"
          >
            {busy === "revoke" ? "Revoking…" : "Revoke agent"}
          </button>
        </>
      )}
      {leftover.data && leftover.data.length > 0 && (
        <div className="stack-sm">
          <p className="small muted">
            The approvals you gave the agent are still open. Set them to zero so nothing can use them later.
          </p>
          <button
            type="button"
            className="btn btn--secondary btn--small self-start"
            disabled={working}
            onClick={() => void zeroAllowances(leftover.data ?? [])}
            data-testid="agent-zero-allowances"
          >
            Set allowances to zero
          </button>
        </div>
      )}
      {statusLine}
      <TxStatus state={runner.state} />
    </form>
  );
}

function GrantRow({
  grant: g,
  meta,
  cancelBid,
  onCancelBid,
  onDelete,
  disabled,
}: {
  grant: GrantDto;
  meta: MarketMeta;
  cancelBid: boolean;
  onCancelBid: (value: boolean) => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const U = meta.underlying;
  const pay = g.payIdx !== null ? meta.payTokens[g.payIdx] : undefined;
  const limit =
    g.kind === "sell"
      ? `sells at up to ${formatBps(g.maxSellDiscountBps ?? 0)} off`
      : g.kind === "bid"
        ? `bids at ${formatBps(g.minBidDiscountBps ?? 0)} off or more${pay ? ` in ${pay.symbol}` : ""}`
        : "deposits into the Selio Vault";
  return (
    <li data-testid={`agent-grant-row-${g.id}`} data-status={g.status}>
      <span className="small">
        <b>{KIND_LABEL[g.kind]}</b> above <b className="mono">{formatBps(g.thresholdBps)}</b> · up to{" "}
        <span className="mono">{formatToken(BigInt(g.maxPerAction), U)}</span> per action,{" "}
        <span className="mono">{formatToken(BigInt(g.maxTotal), U)}</span> in all · used{" "}
        <span className="mono">{formatToken(BigInt(g.usedTotal), U)}</span> · {limit} · until {when(g.expiresAt)}{" "}
        <Chip tone={g.status === "active" ? "open" : "neutral"}>{GRANT_STATUS[g.status]}</Chip>
      </span>
      {g.status !== "revoked" && (
        <span className="row-sm">
          {g.kind === "bid" && (
            <label className="row-sm small">
              <input
                type="checkbox"
                checked={cancelBid}
                onChange={(e) => onCancelBid(e.target.checked)}
                data-testid={`agent-grant-cancelbid-${g.id}`}
              />
              Also cancel the agent's open bid
            </label>
          )}
          <button
            type="button"
            className="btn btn--secondary btn--small"
            disabled={disabled}
            onClick={onDelete}
            data-testid={`agent-grant-delete-${g.id}`}
          >
            Delete
          </button>
        </span>
      )}
    </li>
  );
}

function ActionRow({ action: a, meta, txUrl }: { action: ActionDto; meta: MarketMeta; txUrl: (hash: string) => string | null }) {
  const U = meta.underlying;
  return (
    <li data-testid={`agent-action-row-${a.id}`} data-status={a.status}>
      <span className="small">
        {when(a.at)} · <b>{ACTION_LABEL[a.kind]}</b>
        {a.assets !== null && (
          <>
            {" "}
            · <span className="mono">{formatToken(BigInt(a.assets), U)}</span>
          </>
        )}
        {a.kind === "sell" && a.fee !== null && (
          <>
            {" "}
            · {feeLabel(meta.feeBps)} <span className="mono">{formatToken(BigInt(a.fee), U)}</span>
          </>
        )}
        {a.kind === "sell" && a.net !== null && (
          <>
            {" "}
            · You received <span className="mono">{formatToken(BigInt(a.net), U)}</span>
          </>
        )}{" "}
        · {ACTION_STATUS[a.status]}
        {a.message && ` · ${a.message}`}
      </span>
      {a.txHashes.length > 0 && (
        <span className="row-sm small">
          {a.txHashes.map((hash) => {
            const url = txUrl(hash);
            return url ? (
              <a key={hash} className="mono" href={url} target="_blank" rel="noreferrer">
                {hash.slice(0, 6)}…{hash.slice(-4)} ↗
              </a>
            ) : (
              <span key={hash} className="mono" title={hash}>
                {hash.slice(0, 6)}…{hash.slice(-4)}
              </span>
            );
          })}
        </span>
      )}
    </li>
  );
}
