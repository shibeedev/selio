import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signReviewResponse,
  verifyDynamicEventSignature,
  verifyReviewSignature,
  verifySelioSignature,
} from "./signatures.js";

// RFC 4231 test case 2 (HMAC-SHA256): key "Jefe", data "what do ya want for nothing?".
const SECRET = "Jefe";
const BODY = Buffer.from("what do ya want for nothing?");
const DIGEST = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

// Fixture builder for bodies made in the tests (computed independently of the code under test).
const hmac = (secret: string, body: Buffer) => createHmac("sha256", secret).update(body).digest("hex");

const prefixed = [
  ["X-Selio-Signature", verifySelioSignature],
  ["x-dynamic-signature-256", verifyDynamicEventSignature],
] as const;

describe("HMAC signature checks", () => {
  it("the fixture digest is the RFC 4231 value", () => {
    expect(hmac(SECRET, BODY)).toBe(DIGEST);
  });

  for (const [name, check] of prefixed) {
    describe(name, () => {
      it("accepts the sha256=<hex> value of the raw body", () => {
        expect(check(SECRET, BODY, `sha256=${DIGEST}`)).toBe(true);
        expect(check(SECRET, BODY, `sha256=${DIGEST.toUpperCase()}`)).toBe(true);
      });

      it("rejects a wrong secret, a wrong length, a bare digest and a missing header", () => {
        expect(check("jefe", BODY, `sha256=${DIGEST}`)).toBe(false);
        expect(check(SECRET, BODY, `sha256=${DIGEST.slice(0, -2)}`)).toBe(false);
        expect(check(SECRET, BODY, `sha256=${DIGEST}00`)).toBe(false);
        expect(check(SECRET, BODY, DIGEST)).toBe(false);
        expect(check(SECRET, BODY, undefined)).toBe(false);
      });

      it("rejects the same JSON re-serialized with other whitespace", () => {
        const raw = Buffer.from('{"type":"selio.capacity.alert","at":1}');
        const header = `sha256=${hmac(SECRET, raw)}`;
        expect(check(SECRET, raw, header)).toBe(true);
        const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2));
        expect(check(SECRET, reserialized, header)).toBe(false);
      });
    });
  }

  describe("x-dynamic-signature (Transaction Review)", () => {
    it("accepts the plain hex digest of the raw body", () => {
      expect(verifyReviewSignature(SECRET, BODY, DIGEST)).toBe(true);
    });

    it("rejects a wrong secret, a wrong length, a prefixed value and a missing header", () => {
      expect(verifyReviewSignature("jefe", BODY, DIGEST)).toBe(false);
      expect(verifyReviewSignature(SECRET, BODY, DIGEST.slice(1))).toBe(false);
      expect(verifyReviewSignature(SECRET, BODY, `sha256=${DIGEST}`)).toBe(false);
      expect(verifyReviewSignature(SECRET, BODY, undefined)).toBe(false);
    });

    it("rejects a body re-serialized with other whitespace", () => {
      const raw = Buffer.from('{"shareSetType":"delegated"}');
      const digest = hmac(SECRET, raw);
      expect(verifyReviewSignature(SECRET, raw, digest)).toBe(true);
      expect(verifyReviewSignature(SECRET, Buffer.from('{ "shareSetType": "delegated" }'), digest)).toBe(false);
    });
  });
});

describe("review response signature", () => {
  it("signs the exact response bytes with Ed25519", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = Buffer.from('{"proceed":true}');
    const signature = Buffer.from(signReviewResponse(privateKey, body), "base64");
    expect(verify(null, body, publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from('{"proceed":false}'), publicKey, signature)).toBe(false);
  });
});
