import { useCallback, useState } from "react";
import type { Address, Hex } from "viem";
import type { SelioClient, TokenInfo, UnsignedTx } from "@selio/sdk";
import { describeError } from "./errors";
import { formatToken } from "./format";
import { useNetwork } from "./network-context";
import { useWallet } from "./wallet-context";

/**
 * Aave can take a costlier branch at execution than during estimation (on a Monad mainnet fork an Aave
 * withdraw was estimated at 181,232 gas and used 183,151). Monad charges the gas limit, not gas used,
 * but the buffer stays because the estimate can be short.
 */
export function withGasBuffer(estimate: bigint): bigint {
  return (estimate * 13n) / 10n;
}

/** An aToken transfer can round up by one scaled unit, so an exact allowance can fall short. */
export function withATokenMargin(amount: bigint, transfers: number): bigint {
  return amount + 10n * BigInt(Math.max(1, transfers));
}

export interface TxStep {
  label: string;
  tx: UnsignedTx;
  approval?: boolean;
}

/** An approval of exactly `amount`, or null when the allowance already covers it. */
export async function approvalStep(
  selio: SelioClient,
  token: TokenInfo,
  owner: Address,
  spender: Address,
  amount: bigint,
  why: string,
): Promise<TxStep | null> {
  if (amount === 0n) return null;
  const allowance = await selio.allowance(token.address, owner, spender);
  if (allowance >= amount) return null;
  return {
    label: `Approve ${formatToken(amount, token)} ${why}`,
    tx: selio.approve(token.address, spender, amount),
    approval: true,
  };
}

export type StepPhase = "queued" | "simulating" | "simulated" | "deferred" | "signing" | "pending" | "confirmed" | "failed";

export interface StepView {
  label: string;
  phase: StepPhase;
  hash?: Hex;
  error?: string;
}

export interface RunnerState {
  busy: "simulate" | "send" | null;
  steps: StepView[];
  outcome: "none" | "simulated" | "partial" | "failed" | "sent";
  message: string | null;
}

export interface TxRunner {
  state: RunnerState;
  simulate(build: () => Promise<TxStep[]>): Promise<boolean>;
  send(build: () => Promise<TxStep[]>): Promise<boolean>;
  reset(): void;
}

const IDLE: RunnerState = { busy: null, steps: [], outcome: "none", message: null };

/**
 * One pipeline for every write: steps are built at click time, each is simulated with eth_call right
 * before it is signed, and the sequence stops at the first failure.
 */
export function useTxRunner(): TxRunner {
  const { selio, info, publicClient, refresh } = useNetwork();
  const wallet = useWallet();
  const [state, setState] = useState<RunnerState>(IDLE);

  const setStep = (i: number, patch: Partial<StepView>) =>
    setState((s) => ({ ...s, steps: s.steps.map((step, j) => (j === i ? { ...step, ...patch } : step)) }));

  const simulate = useCallback(
    async (build: () => Promise<TxStep[]>): Promise<boolean> => {
      const account = wallet.address;
      if (!selio || !account) {
        setState({ ...IDLE, outcome: "failed", message: "Connect a wallet to simulate." });
        return false;
      }
      setState({ busy: "simulate", steps: [], outcome: "none", message: null });
      let steps: TxStep[];
      try {
        steps = await build();
      } catch (e) {
        setState({ busy: null, steps: [], outcome: "failed", message: describeError(e) });
        return false;
      }
      setState((s) => ({ ...s, steps: steps.map((step) => ({ label: step.label, phase: "queued" })) }));
      let approved = false;
      let partial = false;
      for (const [i, step] of steps.entries()) {
        // After an approval, later steps can only be simulated once it is on-chain.
        if (approved) {
          setStep(i, { phase: "deferred" });
          partial = true;
          continue;
        }
        setStep(i, { phase: "simulating" });
        try {
          await selio.simulate(step.tx, account);
        } catch (e) {
          const msg = describeError(e);
          setStep(i, { phase: "failed", error: msg });
          setState((s) => ({ ...s, busy: null, outcome: "failed", message: `Simulation failed: ${msg}` }));
          return false;
        }
        setStep(i, { phase: "simulated" });
        if (step.approval) approved = true;
      }
      setState((s) => ({
        ...s,
        busy: null,
        outcome: partial ? "partial" : "simulated",
        message: partial
          ? "The approval simulates fine. The rest is simulated again right after the approval confirms, and nothing more is sent if it fails."
          : "Simulation passed against the current block.",
      }));
      return true;
    },
    [selio, wallet.address],
  );

  const send = useCallback(
    async (build: () => Promise<TxStep[]>): Promise<boolean> => {
      const { address: account, walletClient, writeBlockedReason } = wallet;
      if (!selio || !account || !walletClient || writeBlockedReason) {
        setState({ ...IDLE, outcome: "failed", message: writeBlockedReason ?? "Connect a wallet first." });
        return false;
      }
      setState({ busy: "send", steps: [], outcome: "none", message: null });
      let steps: TxStep[];
      try {
        await wallet.ensureChain();
        steps = await build();
      } catch (e) {
        setState({ busy: null, steps: [], outcome: "failed", message: describeError(e) });
        return false;
      }
      setState((s) => ({ ...s, steps: steps.map((step) => ({ label: step.label, phase: "queued" })) }));
      for (const [i, step] of steps.entries()) {
        const { to, data, value } = step.tx;
        setStep(i, { phase: "simulating" });
        try {
          await selio.simulate(step.tx, account);
        } catch (e) {
          const msg = describeError(e);
          setStep(i, { phase: "failed", error: msg });
          setState((s) => ({ ...s, busy: null, outcome: "failed", message: `Simulation failed, so this step was not sent: ${msg}` }));
          if (i > 0) refresh();
          return false;
        }
        try {
          setStep(i, { phase: "signing" });
          const estimate = await publicClient.estimateGas({ account, to, data, value });
          const hash = await walletClient.sendTransaction({
            account: walletClient.account,
            chain: info.chain,
            to,
            data,
            value,
            gas: withGasBuffer(estimate),
          });
          setStep(i, { phase: "pending", hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
          setStep(i, { phase: "confirmed" });
        } catch (e) {
          const msg = describeError(e);
          setStep(i, { phase: "failed", error: msg });
          setState((s) => ({ ...s, busy: null, outcome: "failed", message: msg }));
          if (i > 0) refresh();
          return false;
        }
      }
      setState((s) => ({ ...s, busy: null, outcome: "sent", message: "Done. Every step is confirmed on-chain." }));
      refresh();
      return true;
    },
    [selio, wallet, publicClient, info, refresh],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { state, simulate, send, reset };
}
