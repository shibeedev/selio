## 1. Introduction

Selio is the exit market for high-utilization lending pools on Monad.

- **For lenders and loopers:** exit in full, even beyond what the pool's utilization allows, by selling the rest of your receipt instantly into Selio's standing bids or through an auction.
- **For borrowers:** buy receipts on Selio at a discount to repay your debt, all in one transaction. No cash needed: with a flash loan, the seller is paid from the freed collateral.
- **For borrowers whose collateral is stuck in a tight pool:** a fallback route sells that collateral through Selio to repay debt or switch collateral.
- **For everyone:** deposit into the Selio Vault. When pool utilization is high, it buys receipts at a discount and later redeems them at full value, earning the gap. Funds waiting in the vault earn base yield automatically where a liquid yield source of the same asset exists.


## 2. Problem it solved

This happens on Monad:

- **A real freeze.** On 7 Aug 2026 at 21:30 UTC, Aave's USDT0 pool on Monad held 123.72M USDT0 of deposits and **0 withdrawable**. 37 minutes later, only 2.89M could leave.
- **Not a one-off.** Between 8 Aug and 7 Sep, that pool spent 261 of 721 hours above its 92% optimal utilization, 13 of them above 98% (as reported by CryptoSlate, 14 Sep 2026).
- **Vaults are exposed too.** On 11 Oct 2026, the Morpho vault Hyperithm USDC Apex held $51.14M with $9.99 of idle cash and no instant-liquidity source.

### Our Innovation on Monad

- **A brand-new market around lending pools** that connects lenders, borrowers and people looking for new ways to earn yield, keeping capital in tight pools moving and creating new demand and steady on-chain activity.
- **A fallback exit layer for lending pools** that lets lenders exit in full even at high utilization, without anyone adding new liquidity. Escrowed limit bids and the Selio Vault are on-chain before the crisis, so sellers get paid from the first block of a freeze.
- **A new source of yield** that pays most when lending markets are under stress: the Selio Vault earns base yield while it waits, then buys receipts at a discount in tight pools and keeps their pool interest until it redeems them at full value.
- **The pool is not drained.** The pool's withdrawable liquidity is the same before and after every buyback, so one seller's exit never takes another lender's exit.
- **Repay debt with an empty wallet.** With a flash loan, Selio repays the borrower's debt first and pays the seller from the collateral that repayment frees: no cash up front and no swaps.


## 3. Demo link:

- Live app: https://selio.site
- Pitch video: https://youtu.be/5ZEEzK7fwu8
- Demo video: https://youtu.be/XQ6f7k7JZy4
- GitHub: https://github.com/shibeedev/selio
- Smart contracts on Monad testnet (chain 10143), source verified on MonadVision, Monadscan and Sourcify:
  - Exit market (MorphoVaultExitMarket): [0x71541206d91607DDE032f7d4a114dfC5A50aA91A](https://testnet.monadvision.com/address/0x71541206d91607DDE032f7d4a114dfC5A50aA91A)
  - Selio Vault USDC (slUSDC): [0xde01fbcff7eb15e63f6E259833326097AEB9465f](https://testnet.monadvision.com/address/0xde01fbcff7eb15e63f6E259833326097AEB9465f)
  - Kuru sell router: [0x9Ca8ce3d4887F76c042cF1A8FB2fF39F6acc30b3](https://testnet.monadvision.com/address/0x9Ca8ce3d4887F76c042cF1A8FB2fF39F6acc30b3)
  - Price router: [0x8d2154AEa272eAA94EAe2020C2bF02A0f672ca21](https://testnet.monadvision.com/address/0x8d2154AEa272eAA94EAe2020C2bF02A0f672ca21)
  - Yield-source probe: [0xeFC28A24F46162345DB95F1022d5C13037e52224](https://testnet.monadvision.com/address/0xeFC28A24F46162345DB95F1022d5C13037e52224)
  - Earn USDC (sim) vault, the receipt (eUSDC): [0x4385eaF60C34989D5Ed5df6a5c58881E8C25479f](https://testnet.monadvision.com/address/0x4385eaF60C34989D5Ed5df6a5c58881E8C25479f)
  - Yield USDC (sim) vault, the base-yield source (yUSDC): [0x652556B7c7cc3c5e6930abBC97BfD601A3A265E9](https://testnet.monadvision.com/address/0x652556B7c7cc3c5e6930abBC97BfD601A3A265E9)
  - Morpho Blue (self-deployed): [0x66DD7A6Dc6E2b68c4C152297aF8bb95e02325571](https://testnet.monadvision.com/address/0x66DD7A6Dc6E2b68c4C152297aF8bb95e02325571)
  - AUSD-sim test token: [0x0a5f7548F50aDB6b61F5f3e68066588979B81C17](https://testnet.monadvision.com/address/0x0a5f7548F50aDB6b61F5f3e68066588979B81C17)

## 4. How it works
### 4.1. Overall

Selio combines five parts:

- **Exit market contracts:** sell now into bids, Dutch auctions, buy and repay with a flash loan, and escrowed limit bids, for lending-pool deposit receipts (Aave V3 and Morpho Vault V2 in this demo).
- **Selio Vault:** anyone can deposit into it. The vault bids by fixed rules, buys receipts below face value in tight pools, redeems them at full value once the pool has cash again, and earns base yield on funds while they wait.
- **Frozen-collateral route:** for borrowers whose collateral is stuck in a pool that cannot pay it out (Aave in this demo).
- **Exit capacity and alerts:** per-pool capacity read from on-chain data, utilization history, and alerts in the app and by webhook.
- **Integration layer:** web app, TypeScript SDK, MCP server for AI agents, backend and event index.

**Monetization:** every fill on Selio's market pays a fixed 0.2% fee, taken from what the seller receives; the Kuru leg of a routed sale pays only the Kuru market's own taker fee. 

### 4.2.1 Core feature 1: Sell now or auction

**Who uses it:** lenders and loopers holding a receipt they cannot redeem.

**What they get:** exit in full now, at a market-set discount, instead of waiting.

**How it works:**

- **Sell now:** fills the best standing bids first, including the Selio Vault's, and pays in the same transaction.
- **Dutch auction:** the discount rises over time until a buyer takes it; a standing bid at that level can be matched.
- **Withdraw any time:** the unsold part comes back at once.

### 4.2.2 Core feature 2: Buy and repay

**Who uses it:** borrowers who owe the same asset as the receipt's pool.

**What they get:** they repay debt for less than face value, even with no cash.

**How it works:**

- Selio flash-borrows the asset, repays the buyer's debt by the receipts' face value, redeems the seller's receipts with the liquidity this adds, and returns the loan.
- The buyer pays the discounted price from the wallet or from the collateral the repayment frees. Example: Bob's 50 USDT0 debt is repaid, and Alice receives WETH from Bob's freed collateral worth 50 USDT0 minus the discount and the 0.2% fee.
- One transaction: if any step fails, nothing happens. No smart account needed.
- **Flash sources:** on Aave, Morpho Blue's free flash loan where possible, otherwise Aave's own (0.05%); on Morpho, Morpho's free flash loan, and for a vault without instant liquidity Selio force-deallocates exactly what the repayment added.

### 4.2.3 Core feature 3: Earn with limit bids and the Selio Vault

**Who uses it:** anyone with idle stablecoins, plus treasuries, market makers and bots.

**What they get:** base yield while waiting, receipts below face value in tight pools, and full value on recovery.

**How it works:**

- **Limit bids:** fully escrowed, never fill below your discount, cancel any time.
- **Selio Vault:** deposit and let the vault bid by fixed rules: at least a 3% discount, at most 20% of capital per receipt, never inside the pool it protects. Anyone can trigger recovery; the profit goes to depositors.
- **Base yield:** waiting capital sits in a liquid yield source of the same asset; the vault stops adding at 90% utilization and anyone can then pull it back.
- **Always exit:** redeem any time, in cash, in receipts already bought, or in yield-source shares if the source is stuck.

### 4.2.4 Core feature 4: Frozen-collateral route for borrowers

**Who uses it:** borrowers whose collateral is a receipt its pool cannot pay out (Aave aTokens in this demo).

**What they get:** they can still repay debt or switch collateral.

**How it works:**

- The route sells just enough collateral through Selio, simulated before signing, and returns the rest.
- Not needed on Morpho, where collateral is never lent out.

### 4.2.5 Core feature 5: Exit capacity and alerts

**Who uses it:** lenders, curators, vaults and risk teams.

**What they get:** how much can leave a pool before it freezes, not after.

**How it works:**

- Per pool: withdrawable now, utilization, and exit capacity through borrowers and escrowed bids, labeled Open, Tight (90%+) or Frozen (99%+), with history.
- Signature-gated alerts in the app and by webhook. All data is on-chain and free to read.

## 5. Integration with sponsors

- **Envio:** HyperIndex indexes Selio's market, vault and pool events on Monad testnet and powers the History page and an MCP history tool, since the testnet RPC limits log queries to 100 blocks.
- **Kuru:** frozen receipts trade on Kuru's order book. The Selio Vault quotes there, and sell now takes the better price between Selio and Kuru.
- **Dynamic:** an email or passkey embedded wallet, plus a delegated agent wallet that can only call Selio contracts, within the user's limits, revocable at once.

## 6. Tech stack

- **Chain:** Monad testnet (live), and anvil forks of Monad mainnet for the two scenarios.
- **Contracts:** Solidity, Foundry, OpenZeppelin, Morpho Blue and Vault V2.
- **SDK, MCP and backend:** TypeScript, viem, Model Context Protocol SDK, Node.js, Express, SQLite.
- **Web:** React and Vite.
- **Index:** Envio HyperIndex.
- **Wallets:** Dynamic SDK, browser wallets, and a built-in demo wallet.

## 7. Use of AI
- We used Claude Code to write code, tests, and documentation, under our direction and review.

