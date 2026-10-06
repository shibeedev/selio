/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_RPC_MONAD_TESTNET?: string;
  readonly VITE_RPC_USDT0_REPLAY?: string;
  readonly VITE_RPC_VAULT_FREEZE?: string;
  readonly VITE_DYNAMIC_ENVIRONMENT_ID?: string;
  readonly VITE_AGENT_URL?: string;
  readonly VITE_INDEXER_URL?: string;
}

interface Window {
  ethereum?: import("viem").EIP1193Provider;
}
