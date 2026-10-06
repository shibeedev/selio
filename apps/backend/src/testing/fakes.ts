import type { SelioChain } from "@selio/mcp";
import type { Deployment, NetworkKey } from "@selio/sdk";
import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { AppChainPort } from "../app.js";
import { openDatabase, type Db, type Transactional } from "../shared/db/database.js";
import { migrate } from "../shared/db/migrations.js";
import { AppError } from "../shared/errors/AppError.js";
import type { CapacityReading } from "../shared/integrations/chain/chain.gateway.js";

export const silentLogger = pino({ level: "silent" });

/** Runs the callback without a database, so repository mocks receive `tx === undefined`. */
export const directTransaction: Transactional = (fn) => fn(undefined as unknown as Db);

export function testDb(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export const OWNER = "0x00000000000000000000000000000000000000aa";
export const OTHER_OWNER = "0x00000000000000000000000000000000000000bb";

export const SIGNER = privateKeyToAccount(generatePrivateKey());
export const OTHER_SIGNER = privateKeyToAccount(generatePrivateKey());

/** Signs in over HTTP (nonce, EIP-4361 message, signature, verify) and resolves the session token. */
export async function signIn(app: Express, account: PrivateKeyAccount): Promise<string> {
  const nonce = await request(app).post("/api/auth/nonce").send({ address: account.address }).expect(200);
  const message = createSiweMessage({
    address: account.address,
    chainId: 10143,
    domain: "localhost",
    nonce: nonce.body.nonce,
    uri: "http://localhost",
    version: "1",
  });
  const signature = await account.signMessage({ message });
  const verified = await request(app).post("/api/auth/verify").send({ message, signature }).expect(200);
  return verified.body.token;
}

export const USDT0_REPLAY_DEPLOYMENT: Deployment = {
  network: "usdt0-replay",
  chainId: 143,
  deployBlock: 1,
  venue: "aave",
  market: "0x0000000000000000000000000000000000001001",
  receipt: "0x0000000000000000000000000000000000001002",
  underlying: "0x0000000000000000000000000000000000001003",
  priceRouter: "0x0000000000000000000000000000000000001004",
  selioVault: "0x0000000000000000000000000000000000001005",
  payTokens: ["0x0000000000000000000000000000000000001006"],
  aavePool: "0x0000000000000000000000000000000000001007",
  debtToken: "0x0000000000000000000000000000000000001008",
};

/** A capacity reading; withdrawable 10^17 of supplied 10^21 is exactly 9,999 bps. */
export function reading(utilizationBps: number, overrides: Partial<CapacityReading> = {}): CapacityReading {
  return {
    withdrawable: 10n ** 17n,
    supplied: 10n ** 21n,
    utilizationBps,
    debtorCapacity: 2n * 10n ** 20n,
    sessionAssets: 0n,
    bidCapacity: [],
    underlying: { address: USDT0_REPLAY_DEPLOYMENT.underlying, symbol: "USDT0", decimals: 6 },
    ...overrides,
  };
}

/** Only usdt0-replay is deployed and reachable; bid capacity is `discountBps × 10^18` per level. */
export function fakeChain(state: { utilizationBps: number } = { utilizationBps: 9_999 }) {
  const notDeployed = (key: NetworkKey) => new AppError(404, "DEPLOYMENT_NOT_FOUND", `No Selio deployment for ${key}`);
  const chain: AppChainPort = {
    rpcUrl: (key) => `http://127.0.0.1/${key}`,
    deployment: (key) => (key === "usdt0-replay" ? USDT0_REPLAY_DEPLOYMENT : null),
    requireDeployment: (key) => {
      if (key !== "usdt0-replay") throw notDeployed(key);
      return USDT0_REPLAY_DEPLOYMENT;
    },
    deployedNetworks: () => ["usdt0-replay"],
    isReachable: async (key) => key === "usdt0-replay",
    readCapacity: async (key, levels) => {
      if (key !== "usdt0-replay") throw notDeployed(key);
      return reading(state.utilizationBps, {
        bidCapacity: levels.map((d) => ({ discountBps: d, assets: BigInt(d) * 10n ** 18n })),
      });
    },
    publicClient: () => {
      throw new Error("network access is disabled in tests");
    },
  };
  return { ...chain, state };
}

export const emptyMcpChain: SelioChain = {
  list: () => [],
  get: (key) => {
    throw new Error(`No Selio deployment found for ${key}`);
  },
};
