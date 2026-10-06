import { ContractFunctionExecutionError, type BaseError } from "viem";
import { describe, expect, it } from "vitest";
import { aaveExitMarketAbi } from "@selio/sdk";
import { countRead, withReadBudget } from "./budget.js";
import { ToolError, errorMessage } from "./errors.js";

const LIMIT_TEXT =
  "This request needs more than 2 chain reads, the limit of this MCP endpoint. Ask for less (for example a smaller limit in list_bids) or run selio-mcp locally.";

describe("read budget", () => {
  it("lets the budgeted reads pass and refuses every read after them", () => {
    withReadBudget(2, () => {
      countRead();
      countRead();
      expect(() => countRead()).toThrow(ToolError);
      expect(() => countRead()).toThrow(LIMIT_TEXT);
    });
  });

  it("counts nothing outside a budget", () => {
    for (let i = 0; i < 1_000; i++) countRead();
    expect(withReadBudget(undefined, () => (countRead(), "no bound"))).toBe("no bound");
  });

  it("reports the bound through viem's contract error wrapping", () => {
    let limit: unknown;
    withReadBudget(0, () => {
      try {
        countRead();
      } catch (err) {
        limit = err;
      }
    });
    const wrapped = new ContractFunctionExecutionError(limit as BaseError, {
      abi: aaveExitMarketAbi,
      functionName: "capacity",
      contractAddress: "0x0000000000000000000000000000000000001001",
    });
    expect(wrapped.shortMessage).toMatch(/unknown error/);
    expect(errorMessage(wrapped)).toBe(LIMIT_TEXT.replace("more than 2", "more than 0"));
  });
});
