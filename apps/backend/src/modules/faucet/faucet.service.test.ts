import { describe, expect, it, vi } from "vitest";
import { createTransactional } from "../../shared/db/database.js";
import { AppError } from "../../shared/errors/AppError.js";
import { directTransaction, OTHER_OWNER, OWNER, silentLogger, testDb } from "../../testing/fakes.js";
import { FaucetRepository, type FaucetRepositoryPort } from "./faucet.repository.js";
import { FaucetService, type FaucetServiceOptions } from "./faucet.service.js";
import type { KitRunner } from "./faucet.types.js";

const W = 600_000;
const NOW = 10_000_000;
const IP = "203.0.113.7";

function repoMock(overrides: Partial<FaucetRepositoryPort> = {}) {
  return {
    lastGrantAt: vi.fn((): number | null => null),
    insertGrant: vi.fn(() => 7),
    deleteGrant: vi.fn(),
    deleteGrantsBefore: vi.fn(),
    ipUsage: vi.fn(() => ({ grants: 0, addresses: 0, first: null as number | null })),
    ipHasAddress: vi.fn(() => false),
    tryAcquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
    ...overrides,
  };
}

function kitsMock(): KitRunner & { runKit: ReturnType<typeof vi.fn> } {
  return { runKit: vi.fn(async () => ["did a thing"]) };
}

function service(repo: FaucetRepositoryPort, kits: KitRunner, options: Partial<FaucetServiceOptions> = {}) {
  return new FaucetService(repo, kits, directTransaction, silentLogger, {
    now: () => NOW,
    newHolderId: () => "holder-1",
    sleep: async () => undefined,
    ...options,
  });
}

describe("FaucetService", () => {
  it("only serves fork networks", async () => {
    const repo = repoMock();
    const kits = kitsMock();
    await expect(
      service(repo, kits).requestKit({ network: "monad-testnet", address: OWNER, kit: "seller", ip: IP }),
    ).rejects.toMatchObject({ statusCode: 403, code: "FAUCET_FORK_ONLY" });
    expect(repo.insertGrant).not.toHaveBeenCalled();
    expect(kits.runKit).not.toHaveBeenCalled();
  });

  it("runs the kit, records the grant and releases the lock", async () => {
    const repo = repoMock();
    const kits = kitsMock();
    const result = await service(repo, kits).requestKit({ network: "usdt0-replay", address: OWNER, kit: "borrower", ip: IP });
    expect(result).toEqual({ ok: true, actions: ["did a thing"] });
    expect(repo.insertGrant).toHaveBeenCalledWith(
      { network: "usdt0-replay", address: OWNER, kit: "borrower", at: NOW, ip: IP },
      undefined,
    );
    expect(kits.runKit).toHaveBeenCalledWith("usdt0-replay", "borrower", OWNER);
    expect(repo.releaseLock).toHaveBeenCalledWith("usdt0-replay", "holder-1");
    expect(repo.deleteGrant).not.toHaveBeenCalled();
  });

  it("rate-limits one kit of each type per address and network per 10 minutes", async () => {
    const limited = repoMock({ lastGrantAt: vi.fn(() => NOW - W + 30_000) });
    await expect(
      service(limited, kitsMock()).requestKit({ network: "vault-freeze", address: OWNER, kit: "seller", ip: IP }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: "FAUCET_RATE_LIMITED",
      message: "A seller kit was already sent to this address on vault-freeze; try again in 30s",
      details: { retryAfterSeconds: 30 },
    });
    expect(limited.lastGrantAt).toHaveBeenCalledWith("vault-freeze", OWNER, "seller", undefined);

    const allowed = repoMock({ lastGrantAt: vi.fn(() => NOW - W) });
    await expect(
      service(allowed, kitsMock()).requestKit({ network: "vault-freeze", address: OWNER, kit: "seller", ip: IP }),
    ).resolves.toEqual({ ok: true, actions: ["did a thing"] });
  });

  it("does not count a failed kit against the limit", async () => {
    const repo = repoMock();
    const kits = kitsMock();
    kits.runKit.mockRejectedValue(new AppError(502, "UPSTREAM_ERROR", "Preparing the seller kit on usdt0-replay failed: boom"));
    await expect(
      service(repo, kits).requestKit({ network: "usdt0-replay", address: OWNER, kit: "seller", ip: IP }),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(repo.deleteGrant).toHaveBeenCalledWith(7);
    expect(repo.releaseLock).toHaveBeenCalledWith("usdt0-replay", "holder-1");
  });

  it("waits for another kit on the same fork, then gives up with 503", async () => {
    const freesLater = repoMock({ tryAcquireLock: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) });
    await service(freesLater, kitsMock()).requestKit({ network: "usdt0-replay", address: OWNER, kit: "seller", ip: IP });
    expect(freesLater.tryAcquireLock).toHaveBeenCalledTimes(2);

    let clock = NOW;
    const busy = repoMock({ tryAcquireLock: vi.fn(() => false) });
    const kits = kitsMock();
    await expect(
      service(busy, kits, {
        now: () => clock,
        lockWaitMs: 1_000,
        sleep: async (ms) => {
          clock += ms;
        },
      }).requestKit({ network: "usdt0-replay", address: OWNER, kit: "seller", ip: IP }),
    ).rejects.toMatchObject({ statusCode: 503, code: "FAUCET_BUSY" });
    expect(busy.deleteGrant).toHaveBeenCalledWith(7);
    expect(kits.runKit).not.toHaveBeenCalled();
  });

  it("limits kits per IP across addresses and kits", async () => {
    let clock = NOW;
    const db = testDb();
    const svc = new FaucetService(new FaucetRepository(db), kitsMock(), createTransactional(db), silentLogger, {
      now: () => clock,
      ipBudget: 2,
    });
    await svc.requestKit({ network: "usdt0-replay", address: OWNER, kit: "seller", ip: IP });
    clock += 1_000;
    await svc.requestKit({ network: "vault-freeze", address: OTHER_OWNER, kit: "bidder", ip: IP });
    clock += 1_000;
    const third = "0x00000000000000000000000000000000000000cc";
    await expect(svc.requestKit({ network: "usdt0-replay", address: third, kit: "borrower", ip: IP })).rejects.toMatchObject({
      statusCode: 429,
      code: "FAUCET_RATE_LIMITED",
      message: "This network address has used its demo-funds budget; try again in 3598s",
      details: { retryAfterSeconds: 3598 },
    });
    await expect(
      svc.requestKit({ network: "usdt0-replay", address: third, kit: "borrower", ip: "198.51.100.9" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("caps distinct addresses per IP", async () => {
    let clock = NOW;
    const db = testDb();
    const svc = new FaucetService(new FaucetRepository(db), kitsMock(), createTransactional(db), silentLogger, {
      now: () => clock,
      ipBudget: 10,
      ipAddresses: 2,
    });
    await svc.requestKit({ network: "usdt0-replay", address: OWNER, kit: "seller", ip: IP });
    clock += 1_000;
    await svc.requestKit({ network: "usdt0-replay", address: OTHER_OWNER, kit: "seller", ip: IP });
    clock += 1_000;
    await expect(
      svc.requestKit({ network: "usdt0-replay", address: "0x00000000000000000000000000000000000000cc", kit: "seller", ip: IP }),
    ).rejects.toMatchObject({
      statusCode: 429,
      message: "Too many different addresses from this network address; try again in 3598s",
    });
    await expect(svc.requestKit({ network: "usdt0-replay", address: OWNER, kit: "bidder", ip: IP })).resolves.toMatchObject({
      ok: true,
    });
  });
});
