import { AsyncLocalStorage } from "node:async_hooks";
import { ToolError } from "./errors.js";

/** Chain reads made so far by the current Streamable HTTP request, and the most it may make. */
export const readBudget = new AsyncLocalStorage<{ used: number; max: number }>();

/** Runs `fn` with a budget of `max` chain reads shared by everything it starts; no budget when `max` is undefined. */
export function withReadBudget<T>(max: number | undefined, fn: () => T): T {
  return max === undefined ? fn() : readBudget.run({ used: 0, max }, fn);
}

/** Counts one chain read against the current budget; throws once the budget is spent. Outside a budget it does nothing. */
export function countRead(): void {
  const budget = readBudget.getStore();
  if (!budget) return;
  budget.used += 1;
  if (budget.used > budget.max) {
    throw new ToolError(
      `This request needs more than ${budget.max} chain reads, the limit of this MCP endpoint. Ask for less (for example a smaller limit in list_bids) or run selio-mcp locally.`,
    );
  }
}
