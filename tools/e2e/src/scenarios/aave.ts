import { encodeFunctionData, formatUnits, maxUint256, parseAbi, type Address } from "viem";
import {
  aaveExitMarketAbi,
  aavePoolAbi,
  erc20Abi,
  priceRouterAbi,
  selioVaultAbi,
  type SelioClient,
  type SessionParams,
} from "@selio/sdk";
import { FREEZER, bidderKit, borrowerKit, refreeze, sellerKit, type KitContext } from "@selio/forkkit";
import { ensureAllowance, expectRevert, fillTotals, send, vaultKuru, type Actor } from "../lib/chain.js";
import { check, near, type Recorder } from "../lib/report.js";

const USD = 10n ** 6n;

function fmt(v: bigint, d = 6): string {
  return Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const escrowAbi = parseAbi(["function totalEscrow(address token) view returns (uint256)"]);

/** aMonUSDT0 the route's borrower supplies: backs its 30,000 USDC borrow at a 50% loan-to-value. */
const ROUTE_COLLATERAL = 60_000n * USD;
/** USDC the borrower owes before the route, and the part the route repays. */
const ROUTE_BORROW = 30_000n * USD;
const ROUTE_REPAY = 20_000n * USD;
/** aMonUSDT0 offered to the route: about 21,100 fetch 20,000 USDC at 5% after the fee; the route returns the rest. */
const ROUTE_OFFER = 25_000n * USD;

export interface AaveScenarioOptions {
  /** Underlying left withdrawable after freezing: > 0 exercises Aave's own flash loan, 0 needs the external source. */
  leave: bigint;
}

export interface AaveActors {
  seller: Actor;
  buyer: Actor;
  bidder: Actor;
  depositor: Actor;
  borrower: Actor;
  keeper: Actor;
}

export async function aaveScenario(
  r: Recorder,
  sdk: SelioClient,
  kit: KitContext,
  a: AaveActors,
  { leave }: AaveScenarioOptions,
): Promise<void> {
  const d = sdk.deployment;
  const market = d.market;
  const underlying = d.underlying;
  const aToken = d.receipt;
  const ausd = d.payTokens[0] as Address;
  const usdc = d.payTokens[1] as Address;
  const weth = d.payTokens[3] as Address;
  const aMonWeth = (d.payATokens ?? [])[3] as Address;
  const pool = d.aavePool as Address;
  const payMask = 0b1111 & ((1 << d.payTokens.length) - 1);
  const bal = (token: Address, who: Address) => sdk.balanceOf(token, who);
  let sessionId = 0n;
  let bidId = 0n;
  let feeRecipient = "0x" as Address;
  /** Sold into the vault's bid: 8 aMonUSDT0, or the Selio bid's share of it while the vault also quotes on Kuru. */
  let vaultSale = 8n * USD;

  await r.step("setup: seller holds 100 aMonUSDT0 in the frozen pool", async () => {
    await sellerKit(kit, a.seller.address, 100n * USD, leave);
    const value = await sdk.receiptValueOf(a.seller.address);
    check(value >= 100n * USD - 10n, `seller aMonUSDT0 ${value}`);
    return { aMonUSDT0: fmt(value) };
  });

  await r.step("setup: buyer owes 60 USDT0 against WETH collateral", async () => {
    await borrowerKit(kit, a.buyer.address, 60n * USD, leave);
    const p = await sdk.position(a.buyer.address);
    // Debt-token rounding can be a base unit short.
    check(p.debt >= 60n * USD - 10n, `debt ${p.debt}`);
    await bidderKit(kit, a.buyer.address, { [ausd]: 500_000n * USD });
    return { debt: fmt(p.debt), healthFactor: fmt(p.health, 18) };
  });

  await r.step("setup: bidder and vault depositor funded; borrower posts aMonUSDT0 and borrows USDC", async () => {
    await bidderKit(kit, a.bidder.address, { [ausd]: 500_000n * USD, [usdc]: 500_000n * USD });
    await bidderKit(kit, a.depositor.address, { [underlying]: 50n * USD });
    await sellerKit(kit, a.borrower.address, ROUTE_COLLATERAL, leave);
    await kit.anvil.sendAs(
      a.borrower.address,
      pool,
      encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [usdc, ROUTE_BORROW, 2n, 0, a.borrower.address] }),
    );
    await refreeze(kit, leave);
  });

  await r.step("pool is frozen: utilization ~100%, nothing (or almost nothing) withdrawable", async () => {
    const c = await sdk.capacity();
    check(c.utilizationBps >= 9990, `utilization ${c.utilizationBps}`);
    check(c.withdrawable <= leave + 1_000n, `withdrawable ${c.withdrawable}`);
    return {
      utilization: `${c.utilizationBps / 100}%`,
      withdrawable: fmt(c.withdrawable),
      debtorCapacity: fmt(c.debtorCapacity),
    };
  });

  await r.step(
    "a visitor donates 1 USDT0 straight to the aMonUSDT0 contract; withdrawable liquidity and flash sizing ignore it",
    async () => {
      const flash = () => sdk.client.readContract({ address: market, abi: aaveExitMarketAbi, functionName: "flashCapacity" });
      const [c0, f0] = await Promise.all([sdk.capacity(), flash()]);
      // A storage write with the balance effect of the plain transfer any visitor can send on a hosted fork.
      await kit.anvil.dealErc20(underlying, aToken, 1n * USD);
      const [c1, f1] = await Promise.all([sdk.capacity(), flash()]);
      check(c1.withdrawable === c0.withdrawable, "donation changed withdrawable");
      check(f1[0] === f0[0], "donation changed flash sizing");
      return { donatedUSDT0: fmt(1n * USD), withdrawable: fmt(c1.withdrawable) };
    },
  );

  await r.step("seller opens a Dutch auction for 50 aMonUSDT0 (1% rising 0.5%/h, cap 15%)", async () => {
    const p: SessionParams = { startBps: 100, stepBps: 50, stepInterval: 3600, capBps: 1500, duration: 604800, payMask };
    await ensureAllowance(r, sdk, a.seller, aToken, market, 50n * USD);
    await send(r, sdk, a.seller, sdk.openSession(50n * USD, p));
    const s = (await sdk.sessions(true))[0];
    check(s && s.seller.toLowerCase() === a.seller.address.toLowerCase(), "session not found");
    near(s.remainingAssets, 50n * USD, 10n, "session size");
    sessionId = s.id;
    return { sessionId: String(s.id), discount: `${s.discountBps / 100}%` };
  });

  await r.step("buyer buys 20 USDT0 of receipts with AUSD; debt repaid in the same tx; liquidity unchanged", async () => {
    feeRecipient = await sdk.feeRecipient();
    const assets = 20n * USD;
    const [c0, p0, seller0, fee0] = await Promise.all([
      sdk.capacity(),
      sdk.position(a.buyer.address),
      bal(ausd, a.seller.address),
      bal(ausd, feeRecipient),
    ]);
    const usdt0Price = await sdk.client.readContract({
      address: d.priceRouter,
      abi: priceRouterAbi,
      functionName: "priceOf",
      args: [underlying],
    });
    near(usdt0Price, 99_938_000n, 1_000n, "USDT0 price");
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, ausd);
    await ensureAllowance(r, sdk, a.buyer, ausd, market, price);
    const { gasUsed } = await send(r, sdk, a.buyer, sdk.buyAndRepay(sessionId, assets, 0, price, "0x"));
    const [c1, p1, seller1, fee1] = await Promise.all([
      sdk.capacity(),
      sdk.position(a.buyer.address),
      bal(ausd, a.seller.address),
      bal(ausd, feeRecipient),
    ]);
    const fee = await sdk.feeOf(price);
    const repaid = p0.debt - p1.debt;
    check(repaid >= (assets * 999n) / 1000n, `debt repaid only ${repaid}`);
    check(seller1 - seller0 === price - fee, "seller not paid the quoted price minus the fee");
    check(fee1 - fee0 === fee, "fee not paid to the recipient");
    near(c1.withdrawable, c0.withdrawable, 2n, "withdrawable liquidity");
    return {
      priceUSDT0: fmt(usdt0Price, 8),
      paidAUSD: fmt(price),
      feeAUSD: fmt(fee),
      debtRepaidUSDT0: fmt(repaid),
      discount: `${s.discountBps / 100}%`,
      withdrawableBefore: fmt(c0.withdrawable),
      withdrawableAfter: fmt(c1.withdrawable),
      gasUsed: gasUsed.toString(),
    };
  });

  await r.step("buyer buys 10 USDT0 in flash mode: seller paid in WETH from freed collateral, no cash used", async () => {
    const assets = 10n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, weth);
    const snapshot = () =>
      Promise.all([
        sdk.position(a.buyer.address),
        bal(weth, a.seller.address),
        bal(weth, a.buyer.address),
        sdk.capacity(),
        bal(weth, feeRecipient),
      ]);
    const [p0, seller0, buyer0, c0, fee0] = await snapshot();
    await ensureAllowance(r, sdk, a.buyer, aMonWeth, market, price);
    await send(r, sdk, a.buyer, sdk.buyAndRepayWithCollateral(sessionId, assets, 3, price, "0x"));
    const [p1, seller1, buyer1, c1, fee1] = await snapshot();
    const fee = await sdk.feeOf(price);
    check(p1.health > p0.health, "health factor did not improve");
    check(seller1 - seller0 === price - fee, "seller WETH mismatch");
    check(fee1 - fee0 === fee, "fee not paid to the recipient");
    check(buyer1 === buyer0, "buyer spent wallet cash");
    near(c1.withdrawable, c0.withdrawable, 2n, "withdrawable liquidity");
    return {
      paidWETH: fmt(price, 18),
      feeWETH: fmt(fee, 18),
      healthBefore: fmt(p0.health, 18),
      healthAfter: fmt(p1.health, 18),
    };
  });

  await r.step("guards: no debt, no purchase; price above the buyer's limit reverts", async () => {
    const noDebt = await expectRevert(sdk, a.keeper, sdk.buyAndRepay(sessionId, 1n * USD, 0, maxUint256, "0x"));
    check(noDebt.startsWith("DebtTooSmall"), noDebt);
    const tooCheap = await expectRevert(sdk, a.buyer, sdk.buyAndRepay(sessionId, 1n * USD, 0, 1n, "0x"));
    check(tooCheap.startsWith("PriceTooHigh"), tooCheap);
    return { noDebt, tooCheap };
  });

  await r.step("bidder escrows a 5% AUSD limit bid for up to 10 USDT0", async () => {
    const escrow = await sdk.quote(10n * USD, 500, ausd);
    await ensureAllowance(r, sdk, a.bidder, ausd, market, escrow);
    await send(r, sdk, a.bidder, sdk.placeBid(500, 0, 10n * USD, escrow));
    const bid = (await sdk.bids()).find((b) => b.bidder.toLowerCase() === a.bidder.address.toLowerCase());
    check(bid, "bid not listed");
    bidId = bid.id;
    return { bidId: String(bid.id), escrowAUSD: fmt(bid.escrow), capacityUSDT0: fmt(bid.capacityAssets) };
  });

  await r.step("seller sells 4 aMonUSDT0 now into the best bid and is paid immediately", async () => {
    const plan = await sdk.planSellNow(4n * USD, 1000, 0b0001);
    check(plan.filledAssets === 4n * USD, `plan filled ${plan.filledAssets}`);
    const [seller0, fee0] = await Promise.all([bal(ausd, a.seller.address), bal(ausd, feeRecipient)]);
    await ensureAllowance(r, sdk, a.seller, aToken, market, plan.filledAssets);
    await send(r, sdk, a.seller, sdk.sellNow(plan, 1000, 0b0001, plan.filledAssets));
    const [seller1, fee1] = await Promise.all([bal(ausd, a.seller.address), bal(ausd, feeRecipient)]);
    check(seller1 - seller0 === (plan.sellerNet[ausd] ?? 0n), "proceeds differ from plan");
    check(fee1 - fee0 === (plan.fees[ausd] ?? 0n), "fee not paid to the recipient");
    return {
      proceedsAUSD: fmt(plan.proceeds[ausd] ?? 0n),
      feeAUSD: fmt(plan.fees[ausd] ?? 0n),
      averageDiscount: `${plan.averageDiscountBps / 100}%`,
    };
  });

  await r.step("auction discount climbs to the bid's 5% and a keeper matches them", async () => {
    await kit.anvil.increaseTime(9 * 3600);
    const s = await sdk.session(sessionId);
    check(s.discountBps >= 500, `discount ${s.discountBps}`);
    const [bidder0, seller0, fee0] = await Promise.all([
      sdk.receiptValueOf(a.bidder.address),
      bal(ausd, a.seller.address),
      bal(ausd, feeRecipient),
    ]);
    const { hash } = await send(r, sdk, a.keeper, sdk.matchBid(sessionId, bidId));
    const fill = await fillTotals(sdk, hash);
    const [bidder1, seller1, fee1] = await Promise.all([
      sdk.receiptValueOf(a.bidder.address),
      bal(ausd, a.seller.address),
      bal(ausd, feeRecipient),
    ]);
    check(fill.count > 0, "no BidFilled event");
    check(bidder1 - bidder0 > 5n * USD, `bidder gained ${bidder1 - bidder0}`);
    check(seller1 - seller0 === fill.paid - fill.fee, "seller not paid net of the fee");
    check(fee1 - fee0 === fill.fee, "fee not paid to the recipient");
    return { discount: `${s.discountBps / 100}%`, filledUSDT0: fmt(fill.assets), feeAUSD: fmt(fill.fee) };
  });

  await r.step("depositor puts 50 USDT0 in the Selio Vault; it bids 3% for up to 20% of capital", async () => {
    const assets = 50n * USD;
    await ensureAllowance(r, sdk, a.depositor, underlying, d.selioVault, assets);
    const minShares = await sdk.vaultPreviewDeposit(assets);
    const tooFewShares = await expectRevert(sdk, a.depositor, sdk.vaultDeposit(assets, a.depositor.address, minShares + 1n));
    await send(r, sdk, a.depositor, sdk.vaultDeposit(assets, a.depositor.address, minShares));
    const v = await sdk.vaultState(a.depositor.address);
    check(v.bidId > 0n, "vault has no bid");
    const bid = (await sdk.bids()).find((b) => b.id === v.bidId);
    check(bid && bid.minDiscountBps === 300, "vault bid wrong");
    // The room under the 20% cap is 10 USDT0; the vault may quote up to its Kuru share of it on Kuru, the rest in
    // its Selio bid.
    const kuru = await vaultKuru(sdk);
    const room = (v.totalAssets * BigInt(v.maxShareBps)) / 10_000n;
    near(bid.escrow + kuru.escrow, room, 10n, "vault escrow");
    check(kuru.escrow <= (room * BigInt(kuru.shareBps)) / 10_000n, `vault quotes ${kuru.escrow} on Kuru`);
    if (kuru.escrow > 0n) vaultSale = (vaultSale * BigInt(10_000 - kuru.shareBps)) / 10_000n;
    return {
      vaultTotal: fmt(v.totalAssets),
      bidEscrowUSDT0: fmt(bid.escrow),
      kuruEscrowUSDT0: fmt(kuru.escrow),
      tooFewShares,
    };
  });

  await r.step(
    `seller sells ${fmt(vaultSale)} aMonUSDT0 into the vault's bid, re-sized by anyone in between, and receives USDT0 at once`,
    async () => {
      const assets = vaultSale;
      const plan = await sdk.planSellNow(assets, 300, 0b0100);
      check(plan.filledAssets === assets, `plan filled ${plan.filledAssets}`);
      const before = (await sdk.vaultState()).bidId;
      await send(r, sdk, a.keeper, {
        to: d.selioVault,
        data: encodeFunctionData({ abi: selioVaultAbi, functionName: "refreshBids" }),
        value: 0n,
        description: "Resize the Selio Vault's bids to its capital",
      });
      const after = (await sdk.vaultState()).bidId;
      check(after === before, "vault bid id changed");
      const [seller0, fee0] = await Promise.all([bal(underlying, a.seller.address), bal(underlying, feeRecipient)]);
      await send(r, sdk, a.seller, sdk.sellNow(plan, 300, 0b0100, plan.filledAssets));
      const [seller1, fee1] = await Promise.all([bal(underlying, a.seller.address), bal(underlying, feeRecipient)]);
      const got = seller1 - seller0;
      // For 8 aMonUSDT0 the vault pays 7.76 USDT0; the 0.2% fee on it is 0.01552 USDT0.
      const paid = (assets * 97n) / 100n;
      near(got, paid - (paid * 20n) / 10_000n, 1n, "USDT0 received at 3%");
      check(fee1 - fee0 === (plan.fees[underlying] ?? 0n), "fee not paid to the recipient");
      const [held, cost, kuru] = await Promise.all([
        bal(aToken, d.selioVault),
        // `heldCost` is what the vault paid for the receipts its bid bought (`heldAssets` is their face value), plus
        // what its resting Kuru order could not get back on a cancel.
        sdk.client.readContract({ address: d.selioVault, abi: selioVaultAbi, functionName: "heldCost", args: [0n] }),
        vaultKuru(sdk),
      ]);
      near(held, assets, 10n, "vault holds the receipts");
      near(cost - kuru.pendingCost, paid, 1n, "vault holds the receipts at cost");
      return {
        receivedUSDT0: fmt(got),
        feeUSDT0: fmt(fee1 - fee0),
        vaultHeldAMonUSDT0: fmt(held),
        vaultHeldCostUSDT0: fmt(cost),
        bidId: String(after),
      };
    },
  );

  await r.step("borrower with frozen aMonUSDT0 collateral repays 20,000 USDC by selling it into a USDC bid", async () => {
    await ensureAllowance(r, sdk, a.bidder, usdc, market, 100_000n * USD);
    await send(r, sdk, a.bidder, sdk.placeBid(500, 1, maxUint256 >> 128n, 100_000n * USD));
    const account = () =>
      kit.client.readContract({ address: pool, abi: aavePoolAbi, functionName: "getUserAccountData", args: [a.borrower.address] });
    const before = await account();
    const plan = await sdk.planSellNow(ROUTE_OFFER, 500, 0b0010);
    const route = d.collateralRoute as Address;
    await ensureAllowance(r, sdk, a.borrower, aToken, route, ROUTE_OFFER);
    // The route must at least cover its flash loan of the repayment plus Aave's premium.
    const premiumBps = BigInt(await kit.client.readContract({ address: pool, abi: aavePoolAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" }));
    const minProceeds = ROUTE_REPAY + (ROUTE_REPAY * premiumBps + 5_000n) / 10_000n;
    const fee0 = await bal(usdc, feeRecipient);
    const { hash } = await send(
      r,
      sdk,
      a.borrower,
      sdk.routeRepayWithFrozenCollateral(ROUTE_OFFER, plan, 500, 1, ROUTE_REPAY, minProceeds),
    );
    const fill = await fillTotals(sdk, hash);
    const fee1 = await bal(usdc, feeRecipient);
    const after = await account();
    check(after[5] > before[5], "health did not improve");
    check(after[1] < before[1], "debt did not fall");
    const c = await sdk.capacity();
    check(c.withdrawable <= leave + 1_000n, "route withdrew from the frozen pool");
    check(fill.count > 0, "no BidFilled event");
    check(fee1 - fee0 === fill.fee, "fee not paid to the recipient");
    return { healthBefore: fmt(before[5], 18), healthAfter: fmt(after[5], 18), feeUSDC: fmt(fill.fee) };
  });

  await r.step("seller withdraws the unsold rest of the session immediately", async () => {
    const value0 = await sdk.receiptValueOf(a.seller.address);
    const left = (await sdk.session(sessionId)).remainingAssets;
    await send(r, sdk, a.seller, sdk.withdrawUnsold(sessionId));
    const got = (await sdk.receiptValueOf(a.seller.address)) - value0;
    // Receipts accrue interest between the read and the withdrawal block.
    check(got >= left - 10n && got <= left + left / 100_000n, `unsold returned ${got} vs ${left}`);
    const s = await sdk.session(sessionId);
    check(!s.open, "session still open");
    return { returnedAMonUSDT0: fmt(got) };
  });

  await r.step("pool recovers; anyone triggers the vault's recovery; depositor exits with the discount as profit", async () => {
    const debt = await bal(d.debtToken as Address, FREEZER);
    await kit.anvil.dealErc20(underlying, FREEZER, debt + 1n * USD);
    await kit.anvil.sendAs(FREEZER, underlying, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, maxUint256] }));
    await kit.anvil.sendAs(
      FREEZER,
      pool,
      encodeFunctionData({ abi: aavePoolAbi, functionName: "repay", args: [underlying, maxUint256, 2n, FREEZER] }),
    );
    const c = await sdk.capacity();
    check(c.withdrawable > 10n * USD, "pool did not recover");
    await send(r, sdk, a.keeper, sdk.vaultRecover(0n));
    const v = await sdk.vaultState(a.depositor.address);
    check(v.heldAssets <= 10n, `vault still holds ${v.heldAssets}`);
    const out0 = await bal(underlying, a.depositor.address);
    await send(r, sdk, a.depositor, sdk.vaultRedeem(v.shares, a.depositor.address, a.depositor.address));
    const out1 = await bal(underlying, a.depositor.address);
    check(out1 > 50n * USD, `depositor got ${out1}`);
    return {
      withdrawableNow: fmt(c.withdrawable),
      depositorOutUSDT0: fmt(out1 - out0),
      profitUSDT0: fmt(out1 - 50n * USD),
    };
  });

  await r.step(
    "market holds only escrow: no stray USDT0, receipts back every open session",
    async () => {
      const [held, escrow] = await Promise.all([
        bal(underlying, market),
        sdk.client.readContract({ address: market, abi: escrowAbi, functionName: "totalEscrow", args: [underlying] }),
      ]);
      check(held === escrow, `market USDT0 ${held} vs escrow ${escrow}`);
      return { marketUSDT0: fmt(held) };
    },
    { independent: true },
  );
}
