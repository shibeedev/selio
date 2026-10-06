import {
  decodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  erc20Abi,
  morphoAbi,
  morphoMarketId,
  selioVaultAbi,
  vaultV2Abi,
  type MorphoMarketParams,
  type SelioClient,
  type SessionParams,
} from "@selio/sdk";
import { FREEZER, LIQUIDITY_HELPER, bidderKit, borrowerKit, refreeze, sellerKit, type KitContext } from "@selio/forkkit";
import { ensureAllowance, expectRevert, fillTotals, send, type Actor } from "../lib/chain.js";
import { check, near, type Recorder } from "../lib/report.js";

const USD = 10n ** 6n;
const WAD = 10n ** 18n;

function fmt(v: bigint, d = 6): string {
  return Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

const escrowAbi = parseAbi(["function totalEscrow(address token) view returns (uint256)"]);
const liquidityDataAbi = parseAbi(["function liquidityData() view returns (bytes)"]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const marketParamsType = parseAbiParameters(
  "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) params",
);

export interface MorphoScenarioOptions {
  /** USDC supplied to the deployment's separate flash market so Morpho has flash-loan liquidity. */
  seedFlashLiquidity?: bigint;
  /** Earn-vault holders that withdraw what they can before the freeze (a bank run). */
  bankRunHolders?: Address[];
  /** Ask the venue to force-deallocate (needed when the Earn vault has no liquidity adapter). */
  forceDeallocate?: boolean;
  /** Squeeze the Selio Vault's yield source to 100%, pull it back and redeem in kind (base yield). */
  baseYield?: boolean;
}

export interface MorphoActors {
  seller: Actor;
  buyer: Actor;
  bidder: Actor;
  depositor: Actor;
  keeper: Actor;
}

function approveAs(kit: KitContext, from: Address, token: Address, spender: Address): Promise<Hex> {
  return kit.anvil.sendAs(from, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }));
}

/** Each holder in turn withdraws as much as the Earn vault can still pay out, until withdrawals stop. */
export async function bankRun(
  sdk: SelioClient,
  kit: KitContext,
  holders: Address[],
): Promise<{ withdrawn: bigint; holders: number }> {
  const vault = sdk.deployment.earnVault as Address;
  let withdrawn = 0n;
  let count = 0;
  for (const h of holders) {
    const shares = await sdk.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "balanceOf", args: [h] });
    if (shares === 0n) continue;
    const holderAssets = await sdk.client.readContract({
      address: vault,
      abi: vaultV2Abi,
      functionName: "previewRedeem",
      args: [shares],
    });
    const exitable = (await sdk.capacity()).withdrawable;
    if (exitable <= 1n) break;
    // Each holder takes as much as the vault can still pay out.
    let assets = holderAssets < exitable - 1n ? holderAssets : exitable - 1n;
    while (assets > 0n) {
      try {
        await kit.anvil.sendAs(h, vault, encodeFunctionData({ abi: vaultV2Abi, functionName: "withdraw", args: [assets, h, h] }));
        withdrawn += assets;
        count++;
        break;
      } catch {
        // The adapter rounds against the withdrawer.
        assets = (assets * 999n) / 1000n;
      }
    }
  }
  return { withdrawn, holders: count };
}

/** Repays FREEZER's borrows in every adapter market, so the Earn vault is liquid again. */
async function unfreeze(sdk: SelioClient, kit: KitContext): Promise<void> {
  const d = sdk.deployment;
  const morpho = d.morpho as Address;
  for (const { id, params } of await sdk.morphoMarkets()) {
    const pos = await sdk.client.readContract({ address: morpho, abi: morphoAbi, functionName: "position", args: [id, FREEZER] });
    const borrowShares = pos[1];
    if (borrowShares === 0n) continue;
    const m = await sdk.client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [id] });
    const owed = (borrowShares * m[2]) / m[3] + 1_000n * USD;
    await kit.anvil.dealErc20(d.underlying, FREEZER, owed);
    await approveAs(kit, FREEZER, d.underlying, morpho);
    await kit.anvil.sendAs(
      FREEZER,
      morpho,
      encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params, 0n, borrowShares, FREEZER, "0x"] }),
    );
  }
}

/** FREEZER posts collateral in `market` and borrows `amount` of its loan token. */
async function borrowAs(kit: KitContext, morpho: Address, market: MorphoMarketParams, amount: bigint): Promise<void> {
  const price = await kit.client.readContract({ address: market.oracle, abi: oracleAbi, functionName: "price" });
  // collateral * price / 1e36 * lltv >= debt, with a 2x margin
  const collateral = (amount * 10n ** 36n * 2n * WAD) / (price * market.lltv) + 1n;
  await kit.anvil.dealErc20(market.collateralToken, FREEZER, collateral);
  await approveAs(kit, FREEZER, market.collateralToken, morpho);
  await kit.anvil.sendAs(
    FREEZER,
    morpho,
    encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [market, collateral, FREEZER, "0x"] }),
  );
  await kit.anvil.sendAs(
    FREEZER,
    morpho,
    encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [market, amount, 0n, FREEZER, FREEZER] }),
  );
}

export async function morphoScenario(
  r: Recorder,
  sdk: SelioClient,
  kit: KitContext,
  a: MorphoActors,
  opts: MorphoScenarioOptions = {},
): Promise<void> {
  const d = sdk.deployment;
  const market = d.market;
  const usdc = d.underlying;
  const collateral = d.payTokens[1] as Address;
  const morpho = d.morpho as Address;
  const force = opts.forceDeallocate ?? false;
  const bal = (token: Address, who: Address) => sdk.balanceOf(token, who);
  let sessionId = 0n;
  let bidId = 0n;
  let feeRecipient = "0x" as Address;

  const seedFlash = opts.seedFlashLiquidity;
  if (seedFlash !== undefined) {
    await r.step("setup: a separate Morpho market holds idle USDC (flash-loan liquidity)", async () => {
      const [loanToken, collateralToken, oracle, irm, lltv] = await sdk.client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: "idToMarketParams",
        args: [d.flashMarketId as Hex],
      });
      await kit.anvil.setBalance(LIQUIDITY_HELPER, WAD);
      await kit.anvil.dealErc20(usdc, LIQUIDITY_HELPER, seedFlash);
      await approveAs(kit, LIQUIDITY_HELPER, usdc, morpho);
      await kit.anvil.sendAs(
        LIQUIDITY_HELPER,
        morpho,
        encodeFunctionData({
          abi: morphoAbi,
          functionName: "supply",
          args: [{ loanToken, collateralToken, oracle, irm, lltv }, seedFlash, 0n, LIQUIDITY_HELPER, "0x"],
        }),
      );
      return { flashLiquidityUSDC: fmt(seedFlash) };
    });
  }

  await r.step("setup: seller holds 100,000 USDC of Earn vault shares", async () => {
    await sellerKit(kit, a.seller.address, 100_000n * USD);
    const value = await sdk.receiptValueOf(a.seller.address);
    // Interest accrues while the kit re-freezes the vault.
    check(value >= 100_000n * USD - 2n && value <= 100_100n * USD, `seller position ${value}`);
    return { positionUSDC: fmt(value) };
  });

  await r.step("setup: buyer borrows 60,000 USDC against collateral in the vault's market", async () => {
    await borrowerKit(kit, a.buyer.address, 60_000n * USD);
    await bidderKit(kit, a.buyer.address, { [usdc]: 200_000n * USD });
    const p = await sdk.position(a.buyer.address);
    check(p.debt >= 60_000n * USD, `debt ${p.debt}`);
    return { debtUSDC: fmt(p.debt), health: fmt(p.health, 18) };
  });

  const holders = opts.bankRunHolders;
  if (holders !== undefined) {
    await r.step("bank run: the largest Hyperithm USDC Apex holders withdraw until withdrawals stop", async () => {
      const c = await sdk.capacity();
      const run = await bankRun(sdk, kit, holders);
      return {
        withdrawnUSDC: fmt(run.withdrawn),
        holders: String(run.holders),
        withdrawableBefore: fmt(c.withdrawable),
      };
    });
  }

  await r.step("setup: bidder and vault depositor funded; remaining liquidity borrowed out", async () => {
    await bidderKit(kit, a.bidder.address, { [usdc]: 300_000n * USD });
    await bidderKit(kit, a.depositor.address, { [usdc]: 100_000n * USD });
    await refreeze(kit);
  });

  await r.step("vault is frozen: utilization ~100%, nothing withdrawable", async () => {
    const [c, flash] = await Promise.all([sdk.capacity(), bal(usdc, morpho)]);
    check(c.utilizationBps >= 9990, `utilization ${c.utilizationBps}`);
    check(c.withdrawable <= 10n * USD, `withdrawable ${c.withdrawable}`);
    check(flash > 0n, "no flash-loan liquidity anywhere in Morpho");
    return { utilization: `${c.utilizationBps / 100}%`, supplied: fmt(c.supplied), morphoFlashUSDC: fmt(flash) };
  });

  await r.step("seller opens a Dutch auction for 50,000 USDC of shares (accepts USDC and the collateral)", async () => {
    const amount = await sdk.receiptAmountFor(50_000n * USD);
    const p: SessionParams = { startBps: 100, stepBps: 50, stepInterval: 3600, capBps: 1500, duration: 604800, payMask: 0b11 };
    await ensureAllowance(r, sdk, a.seller, d.receipt, market, amount);
    await send(r, sdk, a.seller, sdk.openSession(amount, p));
    const s = (await sdk.sessions(true))[0];
    check(s && s.seller.toLowerCase() === a.seller.address.toLowerCase(), "session not found");
    sessionId = s.id;
    return { sessionId: String(s.id), sizeUSDC: fmt(s.remainingAssets) };
  });

  await r.step("buyer buys 20,000 USDC of shares with USDC; debt repaid in the same tx; liquidity unchanged", async () => {
    feeRecipient = await sdk.feeRecipient();
    const assets = 20_000n * USD;
    const snapshot = () =>
      Promise.all([sdk.capacity(), sdk.position(a.buyer.address), bal(usdc, a.seller.address), bal(usdc, feeRecipient)]);
    const [c0, p0, seller0, fee0] = await snapshot();
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdc);
    await ensureAllowance(r, sdk, a.buyer, usdc, market, price);
    const venue = await sdk.venueData(a.buyer.address, { force });
    const { gasUsed } = await send(r, sdk, a.buyer, sdk.buyAndRepay(sessionId, assets, 0, price, venue));
    const [c1, p1, seller1, fee1] = await snapshot();
    const fee = await sdk.feeOf(price);
    // A forced deallocation costs the vault's penalty, so the venue repays assets / (1 + penalty).
    const penalty = force
      ? await sdk.client.readContract({
          address: d.receipt,
          abi: vaultV2Abi,
          functionName: "forceDeallocatePenalty",
          args: [d.adapter as Address],
        })
      : 0n;
    const repaid = p0.debt - p1.debt;
    // The repay block is one second after the read.
    near(repaid, (assets * WAD) / (WAD + penalty), assets / 100_000n, "debt repaid");
    check(seller1 - seller0 === price - fee, "seller not paid");
    check(fee1 - fee0 === fee, "fee not paid to the recipient");
    near(c1.withdrawable, c0.withdrawable, 2n, "withdrawable liquidity");
    return { paidUSDC: fmt(price), feeUSDC: fmt(fee), debtRepaidUSDC: fmt(repaid), gasUsed: gasUsed.toString() };
  });

  await r.step("buyer buys 10,000 USDC in flash mode: two signatures, collateral to seller, authorization revoked", async () => {
    const assets = 10_000n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, collateral);
    const [p0, seller0, buyer0, fee0] = await Promise.all([
      sdk.position(a.buyer.address),
      bal(collateral, a.seller.address),
      bal(usdc, a.buyer.address),
      bal(collateral, feeRecipient),
    ]);
    const auth = await sdk.signMorphoAuthorization(a.buyer.wallet, a.buyer.address);
    const venue = await sdk.venueData(a.buyer.address, { auth, force });
    await send(r, sdk, a.buyer, sdk.buyAndRepayWithCollateral(sessionId, assets, 1, price, venue));
    const [p1, seller1, buyer1, fee1, authorized] = await Promise.all([
      sdk.position(a.buyer.address),
      bal(collateral, a.seller.address),
      bal(usdc, a.buyer.address),
      bal(collateral, feeRecipient),
      sdk.client.readContract({ address: morpho, abi: morphoAbi, functionName: "isAuthorized", args: [a.buyer.address, market] }),
    ]);
    const fee = await sdk.feeOf(price);
    check(seller1 - seller0 === price - fee, "seller collateral mismatch");
    check(fee1 - fee0 === fee, "fee not paid to the recipient");
    check(buyer1 === buyer0, "buyer used cash");
    check(p1.health > p0.health, "health did not improve");
    check(!authorized, "authorization survived the transaction");
    const token = await sdk.token(collateral);
    return {
      paidCollateral: `${fmt(price, token.decimals)} ${token.symbol}`,
      feeCollateral: `${fmt(fee, token.decimals)} ${token.symbol}`,
      healthBefore: fmt(p0.health, 18),
      healthAfter: fmt(p1.health, 18),
    };
  });

  await r.step("guard: a buyer without debt cannot buy", async () => {
    // Venue data from the buyer's position, simulated from the keeper, who has no debt.
    const venue = await sdk.venueData(a.buyer.address, { force });
    const noDebt = await expectRevert(sdk, a.keeper, sdk.buyAndRepay(sessionId, 1_000n * USD, 0, maxUint256, venue));
    check(noDebt.startsWith("DebtTooSmall"), noDebt);
    return { noDebt };
  });

  await r.step("bidder escrows a 5% USDC limit bid for up to 10,000 USDC of shares", async () => {
    const escrow = await sdk.quote(10_000n * USD, 500, usdc);
    await ensureAllowance(r, sdk, a.bidder, usdc, market, escrow);
    await send(r, sdk, a.bidder, sdk.placeBid(500, 0, 10_000n * USD, escrow));
    const bid = (await sdk.bids()).find((b) => b.bidder.toLowerCase() === a.bidder.address.toLowerCase());
    check(bid, "bid missing");
    bidId = bid.id;
    return { bidId: String(bid.id), escrowUSDC: fmt(bid.escrow) };
  });

  await r.step("seller sells 4,000 USDC of shares now into the best bid", async () => {
    const plan = await sdk.planSellNow(4_000n * USD, 1000, 0b01);
    const [seller0, fee0] = await Promise.all([bal(usdc, a.seller.address), bal(usdc, feeRecipient)]);
    await ensureAllowance(r, sdk, a.seller, d.receipt, market, maxUint256 >> 1n);
    await send(r, sdk, a.seller, sdk.sellNow(plan, 1000, 0b01, plan.filledAssets));
    const [seller1, fee1] = await Promise.all([bal(usdc, a.seller.address), bal(usdc, feeRecipient)]);
    check(seller1 - seller0 === (plan.sellerNet[usdc] ?? 0n), "proceeds mismatch");
    check(fee1 - fee0 === (plan.fees[usdc] ?? 0n), "fee not paid to the recipient");
    return { proceedsUSDC: fmt(plan.proceeds[usdc] ?? 0n), feeUSDC: fmt(plan.fees[usdc] ?? 0n) };
  });

  await r.step("auction climbs to 5% and a keeper matches it with the bid", async () => {
    await kit.anvil.increaseTime(9 * 3600);
    const s = await sdk.session(sessionId);
    check(s.discountBps >= 500, `discount ${s.discountBps}`);
    const [bidder0, seller0, fee0] = await Promise.all([
      sdk.receiptValueOf(a.bidder.address),
      bal(usdc, a.seller.address),
      bal(usdc, feeRecipient),
    ]);
    const { hash } = await send(r, sdk, a.keeper, sdk.matchBid(sessionId, bidId));
    const fill = await fillTotals(sdk, hash);
    const [bidder1, seller1, fee1] = await Promise.all([
      sdk.receiptValueOf(a.bidder.address),
      bal(usdc, a.seller.address),
      bal(usdc, feeRecipient),
    ]);
    check(fill.count > 0, "no BidFilled event");
    check(bidder1 - bidder0 > 5_000n * USD, `gained ${bidder1 - bidder0}`);
    check(seller1 - seller0 === fill.paid - fill.fee, "seller not paid net of the fee");
    check(fee1 - fee0 === fill.fee, "fee not paid to the recipient");
    return { discount: `${s.discountBps / 100}%`, filledUSDC: fmt(fill.assets), feeUSDC: fmt(fill.fee) };
  });

  await r.step("depositor puts 100,000 USDC in the Selio Vault; it bids 3% for up to 20%", async () => {
    const assets = 100_000n * USD;
    await ensureAllowance(r, sdk, a.depositor, usdc, d.selioVault, assets);
    const minShares = await sdk.vaultPreviewDeposit(assets);
    const tooFewShares = await expectRevert(sdk, a.depositor, sdk.vaultDeposit(assets, a.depositor.address, minShares + 1n));
    await send(r, sdk, a.depositor, sdk.vaultDeposit(assets, a.depositor.address, minShares));
    const v = await sdk.vaultState(a.depositor.address);
    const bid = (await sdk.bids()).find((b) => b.id === v.bidId);
    check(bid, "vault bid missing");
    near(bid.escrow, 20_000n * USD, 1n, "vault escrow");
    return { escrowUSDC: fmt(bid.escrow), tooFewShares };
  });

  await r.step("seller sells 15,000 USDC of shares into the vault's bid, re-sized by anyone in between", async () => {
    const plan = await sdk.planSellNow(15_000n * USD, 300, 0b01);
    const before = (await sdk.vaultState()).bidId;
    await send(r, sdk, a.keeper, {
      to: d.selioVault,
      data: encodeFunctionData({ abi: selioVaultAbi, functionName: "refreshBids" }),
      value: 0n,
      description: "Resize the Selio Vault's bids to its capital",
    });
    const after = (await sdk.vaultState()).bidId;
    check(after === before, "vault bid id changed");
    const [seller0, fee0] = await Promise.all([bal(usdc, a.seller.address), bal(usdc, feeRecipient)]);
    await send(r, sdk, a.seller, sdk.sellNow(plan, 300, 0b01, plan.filledAssets));
    const [seller1, fee1] = await Promise.all([bal(usdc, a.seller.address), bal(usdc, feeRecipient)]);
    const got = seller1 - seller0;
    // The vault pays 14,550 USDC; the 0.2% fee on it is 29.1 USDC.
    near(got, 14_520_900_000n, 2n, "USDC at 3%");
    check(fee1 - fee0 === (plan.fees[usdc] ?? 0n), "fee not paid to the recipient");
    const [held, cost] = await Promise.all([
      sdk.receiptValueOf(d.selioVault),
      // `heldCost` is what the vault paid for the receipts its bid bought (`heldAssets` is their face value).
      sdk.client.readContract({ address: d.selioVault, abi: selioVaultAbi, functionName: "heldCost", args: [0n] }),
    ]);
    near(held, 15_000n * USD, 5n, "vault holdings");
    near(cost, 14_550n * USD, 2n, "vault holdings at cost");
    return {
      receivedUSDC: fmt(got),
      feeUSDC: fmt(fee1 - fee0),
      vaultHeldUSDC: fmt(held),
      vaultHeldCostUSDC: fmt(cost),
      bidId: String(after),
    };
  });

  await r.step("seller withdraws the unsold rest of the session immediately", async () => {
    const left = (await sdk.session(sessionId)).remainingAssets;
    const value0 = await sdk.receiptValueOf(a.seller.address);
    await send(r, sdk, a.seller, sdk.withdrawUnsold(sessionId));
    const got = (await sdk.receiptValueOf(a.seller.address)) - value0;
    // Receipts accrue interest between the read and the withdrawal block.
    check(got >= left - 5n && got <= left + left / 100_000n, `unsold returned ${got} vs ${left}`);
    return { returnedUSDC: fmt(left) };
  });

  await r.step("vault recovers; anyone triggers the vault's redemption; depositor exits with profit", async () => {
    await unfreeze(sdk, kit);
    const c = await sdk.capacity();
    check(c.withdrawable > 15_000n * USD, "vault did not recover");
    await send(r, sdk, a.keeper, sdk.vaultRecover(0n));
    const v = await sdk.vaultState(a.depositor.address);
    check(v.heldAssets <= 5n, `vault still holds ${v.heldAssets}`);
    const out0 = await bal(usdc, a.depositor.address);
    await send(r, sdk, a.depositor, sdk.vaultRedeem(v.shares, a.depositor.address, a.depositor.address));
    const out1 = await bal(usdc, a.depositor.address);
    check(out1 > 100_000n * USD, `depositor got ${out1}`);
    return { depositorOutUSDC: fmt(out1 - out0), profitUSDC: fmt(out1 - 100_000n * USD) };
  });

  if (opts.baseYield) await baseYieldSteps(r, sdk, kit, a);

  await r.step(
    "market holds only escrow; no USDC left behind by flash loans",
    async () => {
      const [held, escrow] = await Promise.all([
        bal(usdc, market),
        sdk.client.readContract({ address: market, abi: escrowAbi, functionName: "totalEscrow", args: [usdc] }),
      ]);
      check(held === escrow, `market USDC ${held} vs escrow ${escrow}`);
      return { marketUSDC: fmt(held) };
    },
    { independent: true },
  );
}

/**
 * The Selio Vault's base yield: capital beyond its bid escrow sits in the yield source; once the source's market is
 * squeezed past 90% anyone pulls back what it can pay, and a redemption pays the rest in kind as source shares.
 */
async function baseYieldSteps(r: Recorder, sdk: SelioClient, kit: KitContext, a: MorphoActors): Promise<void> {
  const d = sdk.deployment;
  const usdc = d.underlying;
  const vault = d.selioVault;
  const morpho = d.morpho as Address;
  const bal = (token: Address, who: Address) => sdk.balanceOf(token, who);
  const deposit = 10_000n * USD;
  const pull = {
    to: vault,
    data: encodeFunctionData({ abi: selioVaultAbi, functionName: "pullFromSource" }),
    value: 0n,
    description: "Pull the Selio Vault's capital back from its yield source",
  };

  await r.step(
    "base yield: a new deposit keeps the bid escrow in cash and the rest in the yield source; a pull-back below 90% reverts",
    async () => {
      const v0 = await sdk.vaultState();
      check(v0.yieldSource !== zeroAddress, "the Selio Vault has no yield source");
      await ensureAllowance(r, sdk, a.depositor, usdc, vault, deposit);
      await send(r, sdk, a.depositor, sdk.vaultDeposit(deposit, a.depositor.address, await sdk.vaultPreviewDeposit(deposit)));
      const [v, cash] = await Promise.all([sdk.vaultState(), bal(usdc, vault)]);
      const bid = (await sdk.bids()).find((b) => b.id === v.bidId);
      check(bid, "vault bid missing");
      near(bid.escrow, ((v0.totalAssets + deposit) * BigInt(v.maxShareBps)) / 10_000n, 2n, "vault escrow");
      check(cash <= 2n, `cash beyond the bid escrow stayed idle: ${cash}`);
      near(v.sourceAssets, v.totalAssets - bid.escrow, 2n, "capital in the yield source");
      check(v.sourceUtilizationBps < 9_000, `source utilization ${v.sourceUtilizationBps}`);
      const notTight = await expectRevert(sdk, a.keeper, pull);
      check(notTight.startsWith("SourceNotTight"), notTight);
      return {
        escrowUSDC: fmt(bid.escrow),
        inSourceUSDC: fmt(v.sourceAssets),
        sourceUtilization: `${v.sourceUtilizationBps / 100}%`,
        notTight,
      };
    },
  );

  await r.step(
    "base yield: the yield market is squeezed past 90%; anyone pulls what the source can pay back to cash, leaving it at 100%",
    async () => {
      const v0 = await sdk.vaultState();
      const data = await sdk.client.readContract({ address: v0.yieldSource, abi: liquidityDataAbi, functionName: "liquidityData" });
      const [yieldMarket] = decodeAbiParameters(marketParamsType, data);
      const m = await sdk.client.readContract({
        address: morpho,
        abi: morphoAbi,
        functionName: "market",
        args: [morphoMarketId(yieldMarket)],
      });
      // Borrow out all but 5% of the market's supply.
      const keep = (m[0] * 5n) / 100n;
      await borrowAs(kit, morpho, yieldMarket, m[0] - m[2] - keep);
      const squeezed = await sdk.vaultState();
      check(squeezed.sourceUtilizationBps >= 9_000, `source utilization ${squeezed.sourceUtilizationBps}`);
      const cash0 = await bal(usdc, vault);
      const { hash } = await send(r, sdk, a.keeper, pull);
      const receipt = await sdk.client.getTransactionReceipt({ hash });
      const pulled = parseEventLogs({ abi: selioVaultAbi, logs: receipt.logs, eventName: "SourcePulled" })[0];
      check(pulled, "no SourcePulled event");
      const [v1, cash1] = await Promise.all([sdk.vaultState(), bal(usdc, vault)]);
      check(pulled.args.assets > 0n, "nothing pulled back");
      check(cash1 - cash0 === pulled.args.assets, "pulled assets not kept in the vault");
      check(v1.sourceShares === squeezed.sourceShares - pulled.args.shares, "source shares not reduced by the pull-back");
      check(v1.sourceUtilizationBps >= 9_990, `source utilization after the pull-back ${v1.sourceUtilizationBps}`);
      return {
        utilizationSqueezed: `${squeezed.sourceUtilizationBps / 100}%`,
        pulledUSDC: fmt(pulled.args.assets),
        utilizationAfter: `${v1.sourceUtilizationBps / 100}%`,
        inSourceUSDC: fmt(v1.sourceAssets),
      };
    },
  );

  await r.step(
    "base yield: with the source at 100%, a redemption pays the source part in kind as source shares and does not revert",
    async () => {
      const v = await sdk.vaultState(a.depositor.address);
      check(v.redeemSourceInKind > 0n, "the preview pays no source shares in kind");
      const source = v.yieldSource;
      const [cash0, shares0] = await Promise.all([bal(usdc, a.depositor.address), bal(source, a.depositor.address)]);
      const { hash } = await send(r, sdk, a.depositor, sdk.vaultRedeem(v.shares, a.depositor.address, a.depositor.address));
      const receipt = await sdk.client.getTransactionReceipt({ hash });
      const inKind = parseEventLogs({ abi: selioVaultAbi, logs: receipt.logs, eventName: "SourceSharesInKind" })[0];
      check(inKind, "no SourceSharesInKind event");
      const [cash1, shares1, left, token] = await Promise.all([
        bal(usdc, a.depositor.address),
        bal(source, a.depositor.address),
        bal(vault, a.depositor.address),
        sdk.token(source),
      ]);
      check(inKind.args.receiver.toLowerCase() === a.depositor.address.toLowerCase(), "source shares paid to someone else");
      check(inKind.args.shares > 0n, "no source shares paid in kind");
      check(shares1 - shares0 === inKind.args.shares, "source shares not received");
      check(cash1 > cash0, "no cash part paid");
      check(left === 0n, `depositor still holds ${left} vault shares`);
      const value = await sdk.client.readContract({
        address: source,
        abi: vaultV2Abi,
        functionName: "convertToAssets",
        args: [inKind.args.shares],
      });
      return {
        cashUSDC: fmt(cash1 - cash0),
        sourceSharesInKind: `${fmt(inKind.args.shares, token.decimals)} ${token.symbol}`,
        inKindValueUSDC: fmt(value),
      };
    },
  );
}
