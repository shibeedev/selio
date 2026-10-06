import { z } from "zod";

/** The parts of MCP tool results the executor reads (Part 5 §C.6). */
const amountView = z.object({ raw: z.string().regex(/^\d+$/), human: z.string(), symbol: z.string() });

export type AmountView = z.infer<typeof amountView>;

export const exitCapacityResult = z.object({ utilization: z.object({ bps: z.number() }) });

export const sellPlanResult = z.object({ filled: amountView, fills: z.array(z.unknown()) });

export const buildResult = z.object({
  transactions: z.array(
    z.object({
      to: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
      value: z.string().regex(/^\d+$/),
    }),
  ),
  details: z
    .object({ fees: z.array(amountView).optional(), sellerNet: z.array(amountView).optional() })
    .passthrough()
    .optional(),
});

export type BuildResult = z.infer<typeof buildResult>;

export const simulationResult = z.object({
  ok: z.boolean(),
  revert: z.object({ name: z.string() }).nullish(),
  message: z.string().optional(),
});

/** Action messages shown to the user. */
export const MESSAGES = {
  noAccess: "The agent no longer has access to this wallet",
  rejected: "Dynamic no longer accepts the agent's access; enable the agent again",
  noApprovals: "The allowance changed; the agent does not sign approvals.",
  monForGas: "Not enough MON for gas; get testnet MON from https://faucet.monad.xyz",
  belowThreshold: "Utilization is back below your threshold",
  grantInactive: "This grant is no longer active",
  noReceipts: "No receipts to sell",
  noBid: "No bid buys within your discount limit",
  allowanceTooSmall: "The allowance left for the agent is too small; raise it in the panel",
  bidTooSmall: "The bid would be too small",
  budgetUsed: "Nothing is left in this grant's budget",
  nothingToDeposit: "Nothing to deposit within your limits",
  noStandingBid: "This grant has no open bid to cancel",
  interrupted: "Interrupted by a restart",
  completedAfterRestart: "Completed after a restart",
  notConfigured: "The exit agent is not configured",
} as const;
