import {
  encodeAbiParameters,
  encodeFunctionData,
  maxUint256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  aavePoolAbi,
  erc20Abi,
  morphoAbi,
  SelioClient,
  vaultV2Abi,
  WAD,
  type Deployment,
  type MorphoMarketParams,
} from "@selio/sdk";
import { Anvil } from "./anvil.js";

export { maxUint256 };

/** Fixed fork-only helper accounts. They hold no keys; anvil impersonation signs for them. */
export const FREEZER: Address = "0x00000000000000000000000000000000f12ee2e1";
export const LIQUIDITY_HELPER: Address = "0x00000000000000000000000000000000110a1d01";

const ETH = 10n ** 18n;
/** Conservative ETH price, in whole USD, used to size WETH collateral on Aave. */
const ETH_PRICE_FLOOR = 1_000n;
/** WETH added on top of the sized collateral (0.01 WETH). */
const WETH_BUFFER = 10n ** 16n;

// vault-freeze only (Monad mainnet accounts, impersonated on the fork).
/** An allocator of Hyperithm USDC Apex. */
const VAULT_FREEZE_ALLOCATOR: Address = "0x345e93f786e485B9f738B9A1A528c6EeF1C73C5f";
/** A large hyperUSDCa holder, used when the allocator above has lost its role. */
const VAULT_FREEZE_HOLDER: Address = "0xD33847382f821094D9079256C25cA1794AB408c6";

const MARKET_PARAMS = {
  type: "tuple",
  components: [
    { name: "loanToken", type: "address" },
    { name: "collateralToken", type: "address" },
    { name: "oracle", type: "address" },
    { name: "irm", type: "address" },
    { name: "lltv", type: "uint256" },
  ],
} as const;

const oracleAbi = [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

const vaultAllocationAbi = parseAbi([
  "function allocate(address adapter, bytes data, uint256 assets)",
  "function isAllocator(address account) view returns (bool)",
  "function absoluteCap(bytes32 id) view returns (uint256)",
  "function relativeCap(bytes32 id) view returns (uint256)",
  "function allocation(bytes32 id) view returns (uint256)",
]);

const adapterIdsAbi = parseAbi([
  "function ids((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams) view returns (bytes32[])",
]);

export interface KitContext {
  anvil: Anvil;
  client: PublicClient;
  deployment: Deployment;
  sdk: SelioClient;
}

export function kitContext(client: PublicClient, deployment: Deployment): KitContext {
  return { anvil: new Anvil(client), client, deployment, sdk: new SelioClient(deployment, client) };
}

export async function fundGas(ctx: KitContext, user: Address, eth = 10n * ETH): Promise<void> {
  await ctx.anvil.setBalance(user, eth);
}

function send(ctx: KitContext, from: Address, to: Address, data: Hex): Promise<Hex> {
  return ctx.anvil.sendAs(from, to, data);
}

function approve(ctx: KitContext, from: Address, token: Address, spender: Address): Promise<Hex> {
  return send(ctx, from, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] }));
}

// ---------- Aave ----------

function aave(ctx: KitContext) {
  const d = ctx.deployment;
  if (d.venue !== "aave" || !d.aavePool || !d.debtToken) throw new Error("not an Aave deployment");
  const weth = d.payTokens[3];
  if (!weth) throw new Error("Aave deployment needs WETH as pay token 3");
  return { pool: d.aavePool, underlying: d.underlying, weth, debtToken: d.debtToken, aToken: d.receipt };
}

/** WETH collateral generous enough to borrow `debt` of the 6-decimal underlying (at down to $1,000 per ETH and 50% LTV). */
function wethCollateralFor(debt: bigint): bigint {
  return (debt * 2n * 10n ** 12n) / ETH_PRICE_FLOOR + WETH_BUFFER;
}

async function aaveSupply(ctx: KitContext, from: Address, asset: Address, amount: bigint, onBehalf: Address): Promise<void> {
  const { pool } = aave(ctx);
  await ctx.anvil.dealErc20(asset, from, amount);
  await approve(ctx, from, asset, pool);
  await send(ctx, from, pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [asset, amount, onBehalf, 0] }));
}

async function aaveBorrow(ctx: KitContext, who: Address, asset: Address, amount: bigint): Promise<void> {
  const { pool } = aave(ctx);
  await send(ctx, who, pool, encodeFunctionData({ abi: aavePoolAbi, functionName: "borrow", args: [asset, amount, 2n, 0, who] }));
}

function aaveLiquidity(ctx: KitContext): Promise<bigint> {
  const { pool, underlying } = aave(ctx);
  return ctx.client.readContract({
    address: pool,
    abi: aavePoolAbi,
    functionName: "getVirtualUnderlyingBalance",
    args: [underlying],
  });
}

/** Borrows the underlying from FREEZER until at most `leave` is withdrawable, restoring the frozen state. */
async function aaveRefreeze(ctx: KitContext, leave: bigint): Promise<void> {
  const { underlying, weth } = aave(ctx);
  const liquidity = await aaveLiquidity(ctx);
  if (liquidity <= leave) return;
  const amount = liquidity - leave;
  await aaveSupply(ctx, FREEZER, weth, wethCollateralFor(amount), FREEZER);
  await aaveBorrow(ctx, FREEZER, underlying, amount);
}

// ---------- Morpho ----------

function morpho(ctx: KitContext) {
  const d = ctx.deployment;
  if (d.venue !== "morpho" || !d.morpho || !d.earnVault || !d.collateral) throw new Error("not a Morpho deployment");
  return { morpho: d.morpho, vault: d.earnVault, usdc: d.underlying, collateral: d.collateral };
}

/** Adapter market whose collateral is the deployment's collateral token (the Earn liquidity market). */
async function borrowMarket(ctx: KitContext): Promise<MorphoMarketParams> {
  const { collateral } = morpho(ctx);
  const found = (await ctx.sdk.morphoMarkets()).find(
    (m) => m.params.collateralToken.toLowerCase() === collateral.toLowerCase(),
  );
  if (!found) throw new Error("no adapter market with the deployment's collateral");
  return found.params;
}

/** Collateral amount (18 decimals assumed for priceable stable collateral) for borrowing `usdcDebt` (6 decimals). */
async function collateralFor(ctx: KitContext, market: MorphoMarketParams, usdcDebt: bigint): Promise<bigint> {
  const price = await ctx.client.readContract({ address: market.oracle, abi: oracleAbi, functionName: "price" });
  // collateral * price / 1e36 * lltv >= debt, with a 2x margin
  return (usdcDebt * 10n ** 36n * 2n * ETH) / (price * market.lltv) + 1n;
}

async function morphoSupplyCollateralAndBorrow(
  ctx: KitContext,
  who: Address,
  market: MorphoMarketParams,
  debt: bigint,
): Promise<void> {
  const m = morpho(ctx);
  const collateral = await collateralFor(ctx, market, debt);
  await ctx.anvil.dealErc20(market.collateralToken, who, collateral);
  await approve(ctx, who, market.collateralToken, m.morpho);
  await send(
    ctx,
    who,
    m.morpho,
    encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [market, collateral, who, "0x"] }),
  );
  await send(ctx, who, m.morpho, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [market, debt, 0n, who, who] }));
}

async function marketLiquidity(ctx: KitContext, id: Hex): Promise<bigint> {
  const m = morpho(ctx);
  const market = await ctx.client.readContract({ address: m.morpho, abi: morphoAbi, functionName: "market", args: [id] });
  return market[0] - market[2];
}

/** Borrows every adapter market's free liquidity from FREEZER (keeps `leave` per market). */
async function morphoRefreeze(ctx: KitContext, leave: bigint): Promise<void> {
  for (const { id, params } of await ctx.sdk.morphoMarkets()) {
    const liquidity = await marketLiquidity(ctx, id);
    if (liquidity <= leave) continue;
    await morphoSupplyCollateralAndBorrow(ctx, FREEZER, params, liquidity - leave);
  }
}

async function morphoDeposit(ctx: KitContext, who: Address, amount: bigint): Promise<void> {
  const { usdc, vault } = morpho(ctx);
  await ctx.anvil.dealErc20(usdc, who, amount);
  await approve(ctx, who, usdc, vault);
  await send(ctx, who, vault, encodeFunctionData({ abi: vaultV2Abi, functionName: "deposit", args: [amount, who] }));
}

function liquidityAdapter(ctx: KitContext): Promise<Address> {
  const { vault } = morpho(ctx);
  return ctx.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "liquidityAdapter" });
}

/** How much more the Earn vault may allocate to `market` under its absolute and relative caps. */
async function allocationRoom(ctx: KitContext, market: MorphoMarketParams): Promise<bigint> {
  const { vault } = morpho(ctx);
  const adapter = ctx.deployment.adapter as Address;
  const [ids, totalAssets] = await Promise.all([
    ctx.client.readContract({ address: adapter, abi: adapterIdsAbi, functionName: "ids", args: [market] }),
    ctx.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "totalAssets" }),
  ]);
  let room = maxUint256;
  for (const id of ids) {
    const [absoluteCap, relativeCap, allocation] = await Promise.all([
      ctx.client.readContract({ address: vault, abi: vaultAllocationAbi, functionName: "absoluteCap", args: [id] }),
      ctx.client.readContract({ address: vault, abi: vaultAllocationAbi, functionName: "relativeCap", args: [id] }),
      ctx.client.readContract({ address: vault, abi: vaultAllocationAbi, functionName: "allocation", args: [id] }),
    ]);
    const relative = (totalAssets * relativeCap) / WAD;
    const cap = relativeCap < WAD && relative < absoluteCap ? relative : absoluteCap;
    const left = cap > allocation ? cap - allocation : 0n;
    if (left < room) room = left;
  }
  return room;
}

/**
 * Moves the Earn vault's idle USDC into the markets its adapter lists (the borrow market first), as the vault's
 * allocator, so that `refreeze` can borrow it out.
 */
async function allocateIdle(ctx: KitContext): Promise<void> {
  const { usdc, vault } = morpho(ctx);
  const adapter = ctx.deployment.adapter as Address;
  const first = await borrowMarket(ctx);
  const markets = (await ctx.sdk.morphoMarkets()).map((m) => m.params).filter((p) => p !== first);
  let idle = await ctx.sdk.balanceOf(usdc, vault);
  for (const market of [first, ...markets]) {
    if (idle === 0n) break;
    const room = await allocationRoom(ctx, market);
    const assets = room < idle ? room : idle;
    if (assets === 0n) continue;
    const data = encodeAbiParameters([MARKET_PARAMS], [market]);
    await send(
      ctx,
      VAULT_FREEZE_ALLOCATOR,
      vault,
      encodeFunctionData({ abi: vaultAllocationAbi, functionName: "allocate", args: [adapter, data, assets] }),
    );
    idle -= assets;
  }
}

/** Gives `user` Earn shares worth `amount` while keeping the vault's cash out of reach of a plain withdrawal. */
async function morphoSeller(ctx: KitContext, user: Address, amount: bigint): Promise<void> {
  const { vault } = morpho(ctx);
  if ((await liquidityAdapter(ctx)) !== zeroAddress) return morphoDeposit(ctx, user, amount);
  // No liquidity adapter (vault-freeze): a deposit would stay idle in the vault, where any holder could withdraw it.
  const allocator = await ctx.client.readContract({
    address: vault,
    abi: vaultAllocationAbi,
    functionName: "isAllocator",
    args: [VAULT_FREEZE_ALLOCATOR],
  });
  if (allocator) {
    await morphoDeposit(ctx, user, amount);
    await allocateIdle(ctx);
    return;
  }
  const shares = await ctx.client.readContract({ address: vault, abi: vaultV2Abi, functionName: "previewWithdraw", args: [amount] });
  await send(ctx, VAULT_FREEZE_HOLDER, vault, encodeFunctionData({ abi: vaultV2Abi, functionName: "transfer", args: [user, shares] }));
}

// ---------- Venue-agnostic kits ----------

/** Restores the frozen state: at most `leave` withdrawable (per market on Morpho). */
export function refreeze(ctx: KitContext, leave = 0n): Promise<void> {
  return ctx.deployment.venue === "aave" ? aaveRefreeze(ctx, leave) : morphoRefreeze(ctx, leave);
}

/** Gives `user` deposit receipts worth about `amount` of the underlying, then re-freezes the pool. */
export async function sellerKit(ctx: KitContext, user: Address, amount: bigint, leave = 0n): Promise<void> {
  await fundGas(ctx, user);
  if (ctx.deployment.venue === "aave") {
    await aaveSupply(ctx, LIQUIDITY_HELPER, aave(ctx).underlying, amount, user);
  } else {
    await morphoSeller(ctx, user, amount);
  }
  await refreeze(ctx, leave);
}

/** Gives `user` a same-asset debt of `debt` with ample collateral, leaving the pool frozen. */
export async function borrowerKit(ctx: KitContext, user: Address, debt: bigint, leave = 0n): Promise<void> {
  await fundGas(ctx, user);
  if (ctx.deployment.venue === "aave") {
    const { underlying, weth } = aave(ctx);
    // Add exactly the liquidity the borrower takes, so the pool stays frozen.
    await aaveSupply(ctx, LIQUIDITY_HELPER, underlying, debt, LIQUIDITY_HELPER);
    await aaveSupply(ctx, user, weth, wethCollateralFor(debt), user);
    await aaveBorrow(ctx, user, underlying, debt);
  } else {
    const m = morpho(ctx);
    let market: MorphoMarketParams;
    if ((await liquidityAdapter(ctx)) !== zeroAddress) {
      await morphoDeposit(ctx, LIQUIDITY_HELPER, debt);
      market = await borrowMarket(ctx);
    } else {
      // No liquidity adapter (vault-freeze): supply the borrower's market directly.
      await ctx.anvil.dealErc20(m.usdc, LIQUIDITY_HELPER, debt);
      market = await borrowMarket(ctx);
      await approve(ctx, LIQUIDITY_HELPER, m.usdc, m.morpho);
      await send(
        ctx,
        LIQUIDITY_HELPER,
        m.morpho,
        encodeFunctionData({ abi: morphoAbi, functionName: "supply", args: [market, debt, 0n, LIQUIDITY_HELPER, "0x"] }),
      );
    }
    await morphoSupplyCollateralAndBorrow(ctx, user, market, debt);
  }
  await refreeze(ctx, leave);
}

/** Gives `user` every payment token so they can place bids or deposit into the Selio Vault. */
export async function bidderKit(ctx: KitContext, user: Address, perToken: Record<Address, bigint>): Promise<void> {
  await fundGas(ctx, user);
  for (const [token, amount] of Object.entries(perToken)) {
    await ctx.anvil.dealErc20(token as Address, user, amount);
  }
}

/** Default bidder amounts: 100k of each stable, 50 of each ETH-like token. */
export async function defaultBidderAmounts(ctx: KitContext): Promise<Record<Address, bigint>> {
  const amounts: Record<Address, bigint> = {};
  for (const t of await ctx.sdk.payTokens()) {
    amounts[t.address] = t.decimals === 6 ? 100_000n * 10n ** 6n : 50n * 10n ** BigInt(t.decimals);
  }
  return amounts;
}
