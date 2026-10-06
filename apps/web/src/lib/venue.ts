// Venue reads the SDK does not offer (candidates for the SDK).
import { decodeAbiParameters, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import {
  aaveExitMarketAbi,
  aavePoolAbi,
  erc20Abi,
  morphoMarketId,
  priceRouterAbi,
  vaultV2Abi,
  type MorphoMarketParams,
  type SelioClient,
} from "@selio/sdk";

export interface AaveAccount {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint;
  healthFactor: bigint;
}

const reserveDataAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

const liquidityDataAbi = parseAbi(["function liquidityData() view returns (bytes)"]);

const MARKET_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "loanToken", type: "address" },
      { name: "collateralToken", type: "address" },
      { name: "oracle", type: "address" },
      { name: "irm", type: "address" },
      { name: "lltv", type: "uint256" },
    ],
  },
] as const;

function aavePool(selio: SelioClient): Address {
  const pool = selio.deployment.aavePool;
  if (!pool) throw new Error("not an Aave deployment");
  return pool;
}

export async function aaveAccount(selio: SelioClient, user: Address): Promise<AaveAccount> {
  const r = await selio.client.readContract({
    address: aavePool(selio),
    abi: aavePoolAbi,
    functionName: "getUserAccountData",
    args: [user],
  });
  return { totalCollateralBase: r[0], totalDebtBase: r[1], liquidationThresholdBps: r[3], healthFactor: r[5] };
}

/** An Aave reserve without a variable debt token (for example WMON on Monad) means nothing can be owed in it. */
export async function aaveVariableDebt(selio: SelioClient, asset: Address, user: Address): Promise<bigint> {
  const reserve = await selio.client.readContract({
    address: aavePool(selio),
    abi: reserveDataAbi,
    functionName: "getReserveData",
    args: [asset],
  });
  if (isAddressEqual(reserve.variableDebtTokenAddress, zeroAddress)) return 0n;
  return selio.client.readContract({ address: reserve.variableDebtTokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [user] });
}

export async function aavePoolPremiumBps(selio: SelioClient): Promise<bigint> {
  const premium = await selio.client.readContract({ address: aavePool(selio), abi: aavePoolAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" });
  return BigInt(premium);
}

export async function aaveFlashTerms(
  selio: SelioClient,
): Promise<{ aaveChunk: bigint; externalChunk: bigint; premiumBps: bigint; maxLoops: bigint }> {
  const market = { address: selio.deployment.market, abi: aaveExitMarketAbi } as const;
  const [chunks, premiumBps, maxLoops] = await Promise.all([
    selio.client.readContract({ ...market, functionName: "flashCapacity" }),
    aavePoolPremiumBps(selio),
    selio.client.readContract({ ...market, functionName: "MAX_LOOPS" }),
  ]);
  return { aaveChunk: chunks[0], externalChunk: chunks[1], premiumBps, maxLoops: BigInt(maxLoops) };
}

/** USD price with 8 decimals. */
export function priceOf(selio: SelioClient, token: Address): Promise<bigint> {
  return selio.client.readContract({
    address: selio.deployment.priceRouter,
    abi: priceRouterAbi,
    functionName: "priceOf",
    args: [token],
  });
}

/** Vault V2 withdrawals pull from its liquidity market, so a buyer borrowing in another market needs a forced deallocation, at a penalty. */
export function isLiquidityMarket(
  liquidityAdapter: Address,
  liquidityData: Hex,
  marketAdapter: Address,
  market: MorphoMarketParams,
): boolean {
  if (!isAddressEqual(liquidityAdapter, marketAdapter) || liquidityData === "0x") return false;
  try {
    const [params] = decodeAbiParameters(MARKET_PARAMS, liquidityData);
    return morphoMarketId(params) === morphoMarketId(market);
  } catch {
    return false;
  }
}

export async function morphoForceTerms(
  selio: SelioClient,
  market: MorphoMarketParams,
): Promise<{ force: boolean; penaltyWad: bigint }> {
  const { earnVault, adapter } = selio.deployment;
  if (!earnVault || !adapter) throw new Error("not a Morpho deployment");
  const [liquidityAdapter, liquidityData, penaltyWad] = await Promise.all([
    selio.client.readContract({ address: earnVault, abi: vaultV2Abi, functionName: "liquidityAdapter" }),
    selio.client.readContract({ address: earnVault, abi: liquidityDataAbi, functionName: "liquidityData" }),
    selio.client.readContract({ address: earnVault, abi: vaultV2Abi, functionName: "forceDeallocatePenalty", args: [adapter] }),
  ]);
  return { force: !isLiquidityMarket(liquidityAdapter, liquidityData, adapter, market), penaltyWad };
}
