import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "./seal.js";

const key = randomBytes(32);
const walletId = "4f1c2a3b-0d5e-4c6f-8a7b-9c0d1e2f3a4b";

function tamper(sealed: string, part: 0 | 1 | 2): string {
  const parts = sealed.split(".");
  const bytes = Buffer.from(parts[part]!, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  parts[part] = bytes.toString("base64url");
  return parts.join(".");
}

describe("seal", () => {
  it("round-trips and uses a fresh IV for every record", () => {
    const a = seal('{"secretShare":"abc"}', key, walletId);
    const b = seal('{"secretShare":"abc"}', key, walletId);
    expect(a).not.toBe(b);
    expect(a.split(".")).toHaveLength(3);
    expect(a).not.toContain("secretShare");
    expect(open(a, key, walletId)).toBe('{"secretShare":"abc"}');
    expect(open(b, key, walletId)).toBe('{"secretShare":"abc"}');
  });

  it("fails on a tampered IV, ciphertext or tag", () => {
    const sealed = seal("wallet api key", key, walletId);
    expect(() => open(tamper(sealed, 0), key, walletId)).toThrow();
    expect(() => open(tamper(sealed, 1), key, walletId)).toThrow();
    expect(() => open(tamper(sealed, 2), key, walletId)).toThrow();
  });

  it("fails when the additional data (wallet id) or the key differs", () => {
    const sealed = seal("wallet api key", key, walletId);
    expect(() => open(sealed, key, "another-wallet")).toThrow();
    expect(() => open(sealed, randomBytes(32), walletId)).toThrow();
  });

  it("refuses malformed records and truncated tags", () => {
    const sealed = seal("x", key, walletId);
    const [iv, ct, tag] = sealed.split(".") as [string, string, string];
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 8).toString("base64url");
    expect(() => open(`${iv}.${ct}.${shortTag}`, key, walletId)).toThrow("Malformed sealed record");
    expect(() => open(`${iv}.${ct}`, key, walletId)).toThrow("Malformed sealed record");
  });
});
