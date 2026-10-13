// Written by scripts/sync-deployment.mjs from contracts/deployments/monad-testnet.json. Do not edit by hand.
// Before the first monad-testnet deployment the values are placeholders; "pnpm check" fails while any remains.
export const DEPLOYMENT = {
  chainId: 10143,
  deployBlock: 70734999,
  market: "0x71541206d91607dde032f7d4a114dfc5a50aa91a",
  selioVault: "0xde01fbcff7eb15e63f6e259833326097aeb9465f",
  earnVault: "0x4385eaf60c34989d5ed5df6a5c58881e8c25479f",
  morpho: "0x66dd7a6dc6e2b68c4c152297af8bb95e02325571",
  adapter: "0x4218ab5d8ffa81d799bd991698832944ab91629f",
  underlying: "0x534b2f3a21130d7a60830c2df862319e593943a3",
  collateral: "0x0a5f7548f50adb6b61f5f3e68066588979b81c17",
  earnMarketId: "0x7ebf8d6c31e8bb33a27a398d8f28ac7f69d2a5c4681110ea69422b49259242d6",
  flashMarketId: "0x62c4e66c415a6d192d7177ca39e501c70a4c202ad2d5e712c21b343f364ee4a2",
} as const;
