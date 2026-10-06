import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

export const aavePoolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getVirtualUnderlyingBalance(address asset) view returns (uint128)",
]);

export const morphoAbi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "struct Authorization { address authorizer; address authorized; bool isAuthorized; uint256 nonce; uint256 deadline; }",
  "struct Signature { uint8 v; bytes32 r; bytes32 s; }",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonce(address) view returns (uint256)",
  "function isAuthorized(address, address) view returns (bool)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function borrow(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
  "function repay(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function supplyCollateral(MarketParams marketParams, uint256 assets, address onBehalf, bytes data)",
  "function withdrawCollateral(MarketParams marketParams, uint256 assets, address onBehalf, address receiver)",
  "function accrueInterest(MarketParams marketParams)",
]);

export const vaultV2Abi = parseAbi([
  "function asset() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function approve(address spender, uint256 shares) returns (bool)",
  "function transfer(address to, uint256 shares) returns (bool)",
  "function deposit(uint256 assets, address onBehalf) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address onBehalf) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address onBehalf) returns (uint256)",
  "function liquidityAdapter() view returns (address)",
  "function forceDeallocatePenalty(address adapter) view returns (uint256)",
]);

export const morphoAdapterAbi = parseAbi([
  "function marketIdsLength() view returns (uint256)",
  "function marketIds(uint256) view returns (bytes32)",
  "function expectedSupplyAssets(bytes32 marketId) view returns (uint256)",
]);
