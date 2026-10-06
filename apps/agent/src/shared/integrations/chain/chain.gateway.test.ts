import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  concat,
  createTestClient,
  http,
  keccak256,
  numberToHex,
  pad,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOYMENT } from "../../../testing/fakes.js";
import { AppError } from "../../errors/AppError.js";
import { ChainGateway, withGasBuffer } from "./chain.gateway.js";

// Ports 8870-8879 are this suite's; the node forks nothing and keeps Monad testnet's chain id.
const PORT = 8870;
const RPC = `http://127.0.0.1:${PORT}`;
const ANVIL = [join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil")].find(existsSync);
// anvil's public test key #0.
const sender = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const MARKET: Address = "0x00000000000000000000000000000000000a11ce";
const REVERTER: Address = "0x000000000000000000000000000000000000dead";

let anvil: ChildProcess | undefined;
let dir: string;
let gateway: ChainGateway;

function writeDeployment(overrides: Record<string, unknown> = {}) {
  const path = join(dir, "monad-testnet.json");
  writeFileSync(path, JSON.stringify({ ...DEPLOYMENT, market: MARKET, ...overrides }));
  return path;
}

async function rpcUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function signed(to: Address, data: Hex, gas?: bigint) {
  const prepared = await gateway.prepare({ from: sender.address, to, data }).catch(() => null);
  const nonce = prepared?.nonce ?? (await gateway.client.getTransactionCount({ address: sender.address, blockTag: "pending" }));
  const fees = prepared ?? (await gateway.client.estimateFeesPerGas());
  return sender.signTransaction({
    type: "eip1559",
    chainId: 10143,
    to,
    data,
    value: 0n,
    nonce,
    gas: gas ?? prepared!.gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
}

describe.skipIf(!ANVIL)("ChainGateway against anvil", () => {
  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--port", String(PORT), "--chain-id", "10143", "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 100));
    dir = mkdtempSync(join(tmpdir(), "selio-agent-chain-"));
    gateway = new ChainGateway({ deploymentsDir: dir, rpcUrl: RPC, receiptTimeoutMs: 20_000 });
    const test = createTestClient({ mode: "anvil", transport: http(RPC) });
    // A market stand-in that emits BidPlaced(42, caller, ...) on any call, and a contract that always reverts.
    const topic = toEventSelector("BidPlaced(uint256,address,uint16,address,uint256,uint256)");
    await test.setCode({ address: MARKET, bytecode: concat(["0x33602a7f", topic, "0x60806000a300"]) });
    await test.setCode({ address: REVERTER, bytecode: "0x60006000fd" });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads monad-testnet.json only when it is a valid Monad testnet deployment, and re-reads it on change", () => {
    expect(() => gateway.deployment()).toThrow(expect.objectContaining({ statusCode: 503, code: "DEPLOYMENT_NOT_FOUND" }));
    const path = writeDeployment({ network: "vault-freeze" });
    expect(() => gateway.deployment()).toThrow(AppError);
    writeFileSync(path, "{not json");
    utimesSync(path, new Date(), new Date(Date.now() + 1_000));
    expect(() => gateway.deployment()).toThrow(AppError);
    writeDeployment({ chainId: 143 });
    utimesSync(path, new Date(), new Date(Date.now() + 2_000));
    expect(() => gateway.deployment()).toThrow(AppError);
    writeDeployment();
    utimesSync(path, new Date(), new Date(Date.now() + 3_000));
    expect(gateway.deployment()).toMatchObject({ network: "monad-testnet", chainId: 10143, market: MARKET });
  });

  it("prepares nonce, buffered gas and EIP-1559 fees for the wallet", async () => {
    expect(await gateway.chainId()).toBe(10143);
    const prepared = await gateway.prepare({ from: sender.address, to: zeroAddress, data: "0x" });
    const estimate = await gateway.client.estimateGas({ account: sender.address, to: zeroAddress, data: "0x", value: 0n });
    expect(prepared.gas).toBe(withGasBuffer(estimate));
    expect(prepared.gas).toBe((21_000n * 13n) / 10n);
    expect(prepared.nonce).toBe(await gateway.client.getTransactionCount({ address: sender.address, blockTag: "pending" }));
    expect(prepared.maxFeePerGas).toBeGreaterThan(0n);
    expect(await gateway.nativeBalance(sender.address)).toBeGreaterThan(0n);
  });

  it("broadcasts a signed transaction under its local hash and reads the market's BidPlaced id from the receipt", async () => {
    writeDeployment();
    const raw = await signed(MARKET, "0x04978e30");
    const hash = await gateway.sendRawTransaction(raw);
    expect(hash).toBe(keccak256(raw));
    expect(await gateway.waitForReceipt(hash)).toEqual({ status: "success", placedBidId: 42n });
    expect(await gateway.findReceipt(hash)).toEqual({ status: "success", placedBidId: 42n });
    const plain = await gateway.sendRawTransaction(await signed(zeroAddress, "0x"));
    expect(await gateway.waitForReceipt(plain)).toEqual({ status: "success", placedBidId: null });
  });

  it("reports a reverted transaction and an unknown hash", async () => {
    const hash = await gateway.sendRawTransaction(await signed(REVERTER, "0x", 60_000n));
    expect((await gateway.waitForReceipt(hash)).status).toBe("reverted");
    expect(await gateway.findReceipt(pad(numberToHex(1), { size: 32 }))).toBeNull();
  });
});
