import { BaseError, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import {
  aaveCollateralRouteAbi,
  aaveExitMarketAbi,
  kuruMarginAccountAbi,
  kuruOrderBookAbi,
  kuruSellRouterAbi,
  morphoVaultExitMarketAbi,
  priceRouterAbi,
  selioVaultAbi,
  testTokenAbi,
} from "@selio/sdk";
import { findRevertData } from "../chain.js";
import { decodeRevert } from "../revert.js";
import { ADDR, AAVE_DEPLOYMENT, fakeChain, fakeNetwork } from "../testing/fakes.js";
import { simulateTransaction } from "./simulate.js";

const errorStringAbi = [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }] as const;

describe("decodeRevert", () => {
  it("decodes Selio custom errors of every contract", () => {
    const priceTooHigh = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "PriceTooHigh", args: [5n, 4n] });
    expect(decodeRevert(priceTooHigh)).toEqual({
      name: "PriceTooHigh",
      signature: "PriceTooHigh(uint256 price, uint256 maxPay)",
      args: ["5", "4"],
    });
    const badAuthorization = encodeErrorResult({ abi: morphoVaultExitMarketAbi, errorName: "BadAuthorization" });
    expect(decodeRevert(badAuthorization)).toMatchObject({ name: "BadAuthorization", args: [] });
    const tooFewShares = encodeErrorResult({ abi: selioVaultAbi, errorName: "InsufficientShares", args: [1n, 2n] });
    expect(decodeRevert(tooFewShares)?.signature).toBe("InsufficientShares(uint256 shares, uint256 minShares)");
    const unknownMarket = encodeErrorResult({ abi: aaveCollateralRouteAbi, errorName: "UnknownMarket" });
    expect(decodeRevert(unknownMarket)?.name).toBe("UnknownMarket");
  });

  it("decodes the price router and test token errors, like the web app", () => {
    const stale = encodeErrorResult({ abi: priceRouterAbi, errorName: "StalePrice", args: [ADDR.USDC, 7n] });
    expect(decodeRevert(stale)).toEqual({
      name: "StalePrice",
      signature: "StalePrice(address token, uint256 updatedAt)",
      args: [ADDR.USDC, "7"],
    });
    const missing = encodeErrorResult({ abi: priceRouterAbi, errorName: "FeedMissing", args: [ADDR.WETH] });
    expect(decodeRevert(missing)?.name).toBe("FeedMissing");
    const badPrice = encodeErrorResult({ abi: priceRouterAbi, errorName: "BadPrice", args: [ADDR.AUSD] });
    expect(decodeRevert(badPrice)?.name).toBe("BadPrice");
    const mintLimit = encodeErrorResult({ abi: testTokenAbi, errorName: "MintLimit" });
    expect(decodeRevert(mintLimit)?.name).toBe("MintLimit");
  });

  it("decodes the Kuru order book, margin account and KuruSellRouter errors of a routed sale", () => {
    const slippage = encodeErrorResult({ abi: kuruOrderBookAbi, errorName: "SlippageExceeded" });
    expect(slippage).toBe("0x8199f5f3");
    expect(decodeRevert(slippage)).toEqual({ name: "SlippageExceeded", signature: "SlippageExceeded()", args: [] });
    expect(decodeRevert(encodeErrorResult({ abi: kuruOrderBookAbi, errorName: "MarketStateError" }))?.name).toBe(
      "MarketStateError",
    );
    expect(decodeRevert(encodeErrorResult({ abi: kuruMarginAccountAbi, errorName: "InsufficientBalance" }))?.name).toBe(
      "InsufficientBalance",
    );
    expect(decodeRevert(encodeErrorResult({ abi: kuruSellRouterAbi, errorName: "BadParams" }))?.name).toBe("BadParams");
  });

  it("decodes Error(string) and returns null for unknown or missing data", () => {
    const nope = encodeErrorResult({ abi: errorStringAbi, errorName: "Error", args: ["nope"] });
    expect(decodeRevert(nope)).toEqual({ name: "Error", signature: "Error(string message)", args: ["nope"] });
    expect(decodeRevert("0xdeadbeef")).toBeNull();
    expect(decodeRevert(undefined)).toBeNull();
  });
});

describe("findRevertData", () => {
  it("finds revert data along the cause chain", () => {
    const inner = Object.assign(new Error("execution reverted"), { data: "0x1234abcd" });
    const err = new BaseError("outer", { cause: new BaseError("middle", { cause: inner }) });
    expect(findRevertData(err)).toBe("0x1234abcd");
    expect(findRevertData(new Error("plain"))).toBeUndefined();
  });
});

describe("simulate_transaction", () => {
  it("dry-runs the call from the sender", async () => {
    const net = fakeNetwork(AAVE_DEPLOYMENT);
    const ctx = { chain: fakeChain({ "usdt0-replay": net.handle }) };
    const res = await simulateTransaction(ctx, {
      network: "usdt0-replay",
      from: ADDR.user,
      to: ADDR.market,
      data: "0x12345678",
    });
    expect(res).toMatchObject({ ok: true });
    expect(net.reads.call).toHaveBeenCalledWith({ from: ADDR.user, to: ADDR.market, data: "0x12345678", value: 0n });
  });

  it("returns a decoded revert as a normal result", async () => {
    const net = fakeNetwork(AAVE_DEPLOYMENT);
    const revertData = encodeErrorResult({ abi: aaveExitMarketAbi, errorName: "DebtTooSmall", args: [1n, 2n] });
    net.reads.call.mockResolvedValue({ ok: false, revertData, message: "execution reverted" });
    const ctx = { chain: fakeChain({ "usdt0-replay": net.handle }) };
    const res = await simulateTransaction(ctx, {
      network: "usdt0-replay",
      from: ADDR.user,
      to: ADDR.market,
      data: "0x12345678",
      value: "0",
    });
    expect(res).toMatchObject({ ok: false, revert: { name: "DebtTooSmall", args: ["1", "2"] }, revertData });
  });
});
