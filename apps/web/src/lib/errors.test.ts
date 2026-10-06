import { encodeErrorResult, zeroAddress, type Abi, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  morphoVaultExitMarketAbi,
  priceRouterAbi,
  selioVaultAbi,
  testTokenAbi,
} from "@selio/sdk";
import { describeError, describeRevertData, extractRevertData, isForkStateError } from "./errors";

type AbiError = Extract<Abi[number], { type: "error" }>;

/** Revert data of `name` from `abi`, with zero-valued arguments. */
function revert(abi: Abi, name: string): Hex {
  const item = abi.find((x): x is AbiError => x.type === "error" && x.name === name);
  if (!item) throw new Error(`no error ${name}`);
  const args = item.inputs.map((i: AbiError["inputs"][number]) => (i.type === "address" ? zeroAddress : i.type === "bool" ? false : i.type === "string" ? "" : 0n));
  return encodeErrorResult({ abi: [item], errorName: name, args } as Parameters<typeof encodeErrorResult>[0]);
}

const solidityError = (reason: string) =>
  encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] }], errorName: "Error", args: [reason] });
const solidityPanic = (code: bigint) =>
  encodeErrorResult({ abi: [{ type: "error", name: "Panic", inputs: [{ type: "uint256", name: "code" }] }], errorName: "Panic", args: [code] });

describe("extractRevertData", () => {
  it("finds revert data deep in the cause chain", () => {
    const data = revert(aaveExitMarketAbi as Abi, "ZeroAmount");
    expect(extractRevertData({ cause: { cause: { data } } })).toBe(data);
  });

  it("looks one level into data.data", () => {
    const data = revert(aaveExitMarketAbi as Abi, "ZeroAmount");
    expect(extractRevertData({ cause: { data: { data } } })).toBe(data);
  });

  it("finds nothing in plain errors or empty data", () => {
    expect(extractRevertData(new Error("x"))).toBeUndefined();
    expect(extractRevertData({ data: "0x" })).toBeUndefined();
  });
});

describe("describeRevertData", () => {
  it("names the market's custom errors", () => {
    expect(describeRevertData(revert(aaveExitMarketAbi as Abi, "DebtTooSmall"))).toMatch(/debt is smaller/);
  });

  it("names the Morpho venue's permission errors", () => {
    expect(describeRevertData(revert(morphoVaultExitMarketAbi as Abi, "BadAuthorization"))).toMatch(/permission/);
  });

  it("names the route's errors", () => {
    expect(describeRevertData(revert(aaveCollateralRouteAbi as Abi, "ProceedsTooLow"))).toMatch(/not raise enough/);
  });

  it("explains numeric Aave reasons", () => {
    expect(describeRevertData(solidityError("35"))).toBe("Aave rejected the call (Aave error code 35).");
  });

  it("passes other reason strings through", () => {
    expect(describeRevertData(solidityError("nope"))).toBe("nope");
  });

  it("explains panics", () => {
    expect(describeRevertData(solidityPanic(17n))).toMatch(/overflow/);
  });

  it("returns null for an unknown selector", () => {
    expect(describeRevertData("0xdeadbeef")).toBeNull();
  });

  it("gives every error of the six ABIs a sentence", () => {
    for (const abi of [aaveExitMarketAbi, morphoVaultExitMarketAbi, selioVaultAbi, aaveCollateralRouteAbi, priceRouterAbi, testTokenAbi]) {
      for (const item of (abi as Abi).filter((x): x is AbiError => x.type === "error")) {
        expect(describeRevertData(revert(abi as Abi, item.name)), item.name).toMatch(/\.$/);
      }
    }
  });
});

describe("describeError", () => {
  it("recognises a rejection in the wallet", () => {
    expect(describeError({ code: 4001 })).toMatch(/rejected/);
    expect(describeError({ cause: { cause: { name: "UserRejectedRequestError" } } })).toMatch(/rejected/);
  });

  it("prefers decoded revert data over the short message", () => {
    const err = { shortMessage: "Execution reverted.", cause: { data: revert(aaveExitMarketAbi as Abi, "InsufficientFill") } };
    expect(describeError(err)).toMatch(/bids changed since the preview/);
  });

  it("explains a fork that cannot load old state", () => {
    const err = { message: "request failed", cause: { details: "historical state 53b5 is not available" } };
    expect(isForkStateError(err)).toBe(true);
    expect(describeError(err)).toMatch(/Demo funds/);
  });

  it("joins the short message and its details", () => {
    expect(describeError({ shortMessage: "Nonce too low.", details: "nonce 3" })).toBe("Nonce too low. nonce 3");
  });

  it("keeps only the first line of a message", () => {
    expect(describeError(new Error("first\nsecond"))).toBe("first");
  });
});
