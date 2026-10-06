import { encodeFunctionData, formatUnits, maxUint256, type Address, type Hex } from "viem";
import {
  morphoAbi,
  selioVaultAbi,
  testTokenAbi,
  vaultV2Abi,
  type MorphoMarketParams,
  type SelioClient,
  type SessionParams,
  type UnsignedTx,
} from "@selio/sdk";
import { ensureAllowance, fillTotals, send, type Actor } from "../lib/chain.js";
import { check, type Recorder } from "../lib/report.js";

const USD = 10n ** 6n;

function fmt(v: bigint, d = 6): string {
  return Number(formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function raw(to: Address, data: Hex, description: string): UnsignedTx {
  return { to, data, value: 0n, description };
}

/**
 * Monad Testnet, self-deployed Morpho Earn stack, testnet funds: the deployer seeds the Earn vault and borrows its
 * liquidity out so it is frozen; the second account borrows and buys.
 */
export async function liveMorphoScenario(
  r: Recorder,
  sdk: SelioClient,
  { seller, buyer }: { seller: Actor; buyer: Actor },
): Promise<void> {
  const d = sdk.deployment;
  const market = d.market;
  const usdc = d.underlying;
  const coll = d.collateral as Address;
  const morpho = d.morpho as Address;
  const vault = d.earnVault as Address;

  const marketParams = async (id: Hex): Promise<MorphoMarketParams> => {
    const [loanToken, collateralToken, oracle, irm, lltv] = await sdk.client.readContract({
      address: morpho,
      abi: morphoAbi,
      functionName: "idToMarketParams",
      args: [id],
    });
    return { loanToken, collateralToken, oracle, irm, lltv };
  };
  const liquidity = async (id: Hex): Promise<bigint> => {
    const m = await sdk.client.readContract({ address: morpho, abi: morphoAbi, functionName: "market", args: [id] });
    return m[0] - m[2];
  };
  const earn = await marketParams(d.earnMarketId as Hex);
  const flash = await marketParams(d.flashMarketId as Hex);
  const params = (startBps: number): SessionParams => ({
    startBps,
    stepBps: 50,
    stepInterval: 3600,
    capBps: 1500,
    duration: 259200,
    payMask: 0b11,
  });

  const borrow = async (who: Actor, amount: bigint): Promise<void> => {
    // AUSD-sim has 18 decimals and is priced 1:1 with USDC; post twice the debt.
    const collateral = amount * 2n * 10n ** 12n;
    await send(r, sdk, who, raw(coll, encodeFunctionData({ abi: testTokenAbi, functionName: "mint", args: [who.address, collateral] }), "Mint test collateral"));
    await ensureAllowance(r, sdk, who, coll, morpho, collateral);
    await send(
      r,
      sdk,
      who,
      raw(
        morpho,
        encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [earn, collateral, who.address, "0x"] }),
        "Supply collateral",
      ),
    );
    await send(
      r,
      sdk,
      who,
      raw(
        morpho,
        encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [earn, amount, 0n, who.address, who.address] }),
        "Borrow USDC",
      ),
    );
  };

  let feeRecipient = "0x" as Address;
  /**
   * Fee checks of one fill transaction: each fill's fee is its payment's 0.2% rounded down, the seller gets the
   * payments net of the fees and the recipient the fees; when the recipient is the seller, the seller gets it all.
   */
  const checkFees = async (hash: Hex, payToken: Address, seller0: bigint, fee0: bigint): Promise<bigint> => {
    const fill = await fillTotals(sdk, hash);
    check(fill.count > 0, "no fill event");
    const [seller1, fee1] = await Promise.all([sdk.balanceOf(payToken, seller.address), sdk.balanceOf(payToken, feeRecipient)]);
    if (feeRecipient.toLowerCase() === seller.address.toLowerCase()) {
      check(seller1 - seller0 === fill.paid, "seller (also the fee recipient) not paid in full");
    } else {
      check(seller1 - seller0 === fill.paid - fill.fee, "seller not paid net of the fee");
      check(fee1 - fee0 === fill.fee, "fee not paid to the recipient");
    }
    return fill.fee;
  };
  const balances = (payToken: Address) =>
    Promise.all([sdk.balanceOf(payToken, seller.address), sdk.balanceOf(payToken, feeRecipient)]);
  const sellerSessions = async () =>
    (await sdk.sessions(true)).filter((s) => s.seller.toLowerCase() === seller.address.toLowerCase());
  let sessionId = 0n;
  let bidId = 0n;

  await r.step("fund the buyer with gas", async () => {
    if ((await sdk.client.getBalance({ address: buyer.address })) < 2n * 10n ** 15n) {
      const hash = await seller.wallet.sendTransaction({
        account: seller.account,
        chain: seller.wallet.chain,
        to: buyer.address,
        value: 3n * 10n ** 15n,
      });
      r.noteTx(hash);
      await sdk.client.waitForTransactionReceipt({ hash });
    }
    return { buyerMON: fmt(await sdk.client.getBalance({ address: buyer.address }), 18) };
  });

  await r.step("seed: 15 USDC of flash liquidity in a separate Morpho market", async () => {
    if ((await liquidity(d.flashMarketId as Hex)) < 10n * USD) {
      await ensureAllowance(r, sdk, seller, usdc, morpho, 15n * USD);
      await send(
        r,
        sdk,
        seller,
        raw(
          morpho,
          encodeFunctionData({ abi: morphoAbi, functionName: "supply", args: [flash, 15n * USD, 0n, seller.address, "0x"] }),
          "Supply flash liquidity",
        ),
      );
    }
    return { flashLiquidityUSDC: fmt(await liquidity(d.flashMarketId as Hex)) };
  });

  await r.step("seed: seller deposits 50 USDC into the Earn vault", async () => {
    if ((await sdk.receiptValueOf(seller.address)) < 20n * USD) {
      await ensureAllowance(r, sdk, seller, usdc, vault, 50n * USD);
      await send(
        r,
        sdk,
        seller,
        raw(
          vault,
          encodeFunctionData({ abi: vaultV2Abi, functionName: "deposit", args: [50n * USD, seller.address] }),
          "Deposit into Earn",
        ),
      );
    }
    return { sellerPositionUSDC: fmt(await sdk.receiptValueOf(seller.address)) };
  });

  await r.step("seed: buyer borrows 20 USDC; the seller borrows what is left so the vault is frozen", async () => {
    if ((await sdk.position(buyer.address)).debt < 10n * USD) await borrow(buyer, 20n * USD);
    const left = await liquidity(d.earnMarketId as Hex);
    if (left > 0n) await borrow(seller, left);
    const [c, p] = await Promise.all([sdk.capacity(), sdk.position(buyer.address)]);
    check(c.utilizationBps >= 9990, `utilization ${c.utilizationBps}`);
    return {
      utilization: `${c.utilizationBps / 100}%`,
      withdrawableUSDC: fmt(c.withdrawable),
      buyerDebtUSDC: fmt(p.debt),
    };
  });

  await r.step("seller takes back unsold shares from earlier runs", async () => {
    const open = await sellerSessions();
    for (const s of open) await send(r, sdk, seller, sdk.withdrawUnsold(s.id));
    return { reclaimed: String(open.length) };
  });

  await r.step("seller opens a Dutch auction for 10 USDC of Earn shares", async () => {
    const amount = await sdk.receiptAmountFor(10n * USD);
    await ensureAllowance(r, sdk, seller, d.receipt, market, maxUint256 >> 1n);
    await send(r, sdk, seller, sdk.openSession(amount, params(100)));
    const s = (await sellerSessions())[0];
    check(s, "session missing");
    sessionId = s.id;
    return { sessionId: String(s.id) };
  });

  await r.step("buyer buys 3 USDC of shares with USDC; debt repaid in the same tx; liquidity unchanged", async () => {
    feeRecipient = await sdk.feeRecipient();
    const assets = 3n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, usdc);
    const [p0, c0, [seller0, fee0]] = await Promise.all([sdk.position(buyer.address), sdk.capacity(), balances(usdc)]);
    await ensureAllowance(r, sdk, buyer, usdc, market, price);
    const { hash } = await send(r, sdk, buyer, sdk.buyAndRepay(sessionId, assets, 0, price, await sdk.venueData(buyer.address)));
    const [p1, c1] = await Promise.all([sdk.position(buyer.address), sdk.capacity()]);
    const repaid = p0.debt - p1.debt;
    check(repaid >= assets - 1_000n, "debt not repaid");
    const fee = await checkFees(hash, usdc, seller0, fee0);
    return {
      tx: hash,
      paidUSDC: fmt(price),
      feeUSDC: fmt(fee),
      debtRepaidUSDC: fmt(repaid),
      withdrawableBefore: fmt(c0.withdrawable),
      withdrawableAfter: fmt(c1.withdrawable),
    };
  });

  await r.step("buyer buys 2 USDC in flash mode with two signatures; collateral to seller; authorization revoked", async () => {
    const assets = 2n * USD;
    const s = await sdk.session(sessionId);
    const price = await sdk.quote(assets, s.discountBps, coll);
    const auth = await sdk.signMorphoAuthorization(buyer.wallet, buyer.address);
    const [seller0, fee0] = await balances(coll);
    const { hash } = await send(
      r,
      sdk,
      buyer,
      sdk.buyAndRepayWithCollateral(sessionId, assets, 1, price, await sdk.venueData(buyer.address, { auth })),
    );
    const authorized = await sdk.client.readContract({
      address: morpho,
      abi: morphoAbi,
      functionName: "isAuthorized",
      args: [buyer.address, market],
    });
    check(!authorized, "authorization survived");
    const fee = await checkFees(hash, coll, seller0, fee0);
    return { tx: hash, paidSimAUSD: fmt(price, 18), feeSimAUSD: fmt(fee, 18) };
  });

  await r.step("buyer places a 5% USDC limit bid for up to 3 USDC", async () => {
    const escrow = await sdk.quote(3n * USD, 500, usdc);
    await ensureAllowance(r, sdk, buyer, usdc, market, escrow);
    await send(r, sdk, buyer, sdk.placeBid(500, 0, 3n * USD, escrow));
    const mine = (await sdk.bids()).filter((b) => b.bidder.toLowerCase() === buyer.address.toLowerCase());
    const bid = mine[mine.length - 1];
    check(bid, "bid missing");
    bidId = bid.id;
    return { bidId: String(bid.id), escrowUSDC: fmt(bid.escrow) };
  });

  await r.step("seller sells 1 USDC of shares now into the bid", async () => {
    const plan = await sdk.planSellNow(1n * USD, 500, 0b01);
    const [seller0, fee0] = await balances(usdc);
    const { hash } = await send(r, sdk, seller, sdk.sellNow(plan, 500, 0b01, plan.filledAssets));
    await checkFees(hash, usdc, seller0, fee0);
    return { tx: hash, proceedsUSDC: fmt(plan.proceeds[usdc] ?? 0n), feeUSDC: fmt(plan.fees[usdc] ?? 0n) };
  });

  await r.step("a session already at 6% is matched with the 5% bid", async () => {
    await send(r, sdk, seller, sdk.openSession(await sdk.receiptAmountFor(1n * USD), params(600)));
    const s = (await sellerSessions()).find((x) => x.startBps === 600);
    check(s, "second session missing");
    const [seller0, fee0] = await balances(usdc);
    const { hash } = await send(r, sdk, seller, sdk.matchBid(s.id, bidId));
    const fee = await checkFees(hash, usdc, seller0, fee0);
    return { tx: hash, feeUSDC: fmt(fee) };
  });

  await r.step("seller deposits 10 USDC into the Selio Vault and sells 1 USDC of shares into its 3% bid", async () => {
    await ensureAllowance(r, sdk, seller, usdc, d.selioVault, 10n * USD);
    await send(r, sdk, seller, sdk.vaultDeposit(10n * USD, seller.address, await sdk.vaultPreviewDeposit(10n * USD)));
    const plan = await sdk.planSellNow(1n * USD, 300, 0b01);
    check(plan.filledAssets > 0n, "no vault bid");
    const [seller0, fee0] = await balances(usdc);
    const { hash } = await send(r, sdk, seller, sdk.sellNow(plan, 300, 0b01, 1n));
    const fee = await checkFees(hash, usdc, seller0, fee0);
    const [v, cost] = await Promise.all([
      sdk.vaultState(seller.address),
      // At cost: what the vault paid for the receipts its bid bought.
      sdk.client.readContract({ address: d.selioVault, abi: selioVaultAbi, functionName: "heldCost", args: [0n] }),
    ]);
    return { tx: hash, feeUSDC: fmt(fee), vaultHeldUSDC: fmt(cost), vaultTotalUSDC: fmt(v.totalAssets) };
  });

  await r.step("seller withdraws unsold shares; buyer cancels leftover bids", async () => {
    for (const s of await sellerSessions()) await send(r, sdk, seller, sdk.withdrawUnsold(s.id));
    for (const b of await sdk.bids()) {
      if (b.bidder.toLowerCase() === buyer.address.toLowerCase()) await send(r, sdk, buyer, sdk.cancelBid(b.id));
    }
    return { sellerUSDC: fmt(await sdk.balanceOf(usdc, seller.address)) };
  });
}
