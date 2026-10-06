/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_RPC_MONAD_TESTNET?: string;
  readonly VITE_RPC_USDT0_REPLAY?: string;
  readonly VITE_RPC_VAULT_FREEZE?: string;
}

interface Window {
  ethereum?: import("viem").EIP1193Provider;
}
