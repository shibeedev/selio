import { createHmac, sign, timingSafeEqual, type KeyObject } from "node:crypto";

export const SELIO_SIGNATURE_HEADER = "x-selio-signature";
export const DYNAMIC_EVENT_SIGNATURE_HEADER = "x-dynamic-signature-256";
export const DYNAMIC_REVIEW_SIGNATURE_HEADER = "x-dynamic-signature";
export const DYNAMIC_RESPONSE_SIGNATURE_HEADER = "x-dynamic-response-signature";

function hmacHex(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Constant-time comparison of equal-length buffers; a length mismatch fails without comparing.
function matches(header: string | undefined, expected: string): boolean {
  if (typeof header !== "string") return false;
  const received = Buffer.from(header.trim().toLowerCase(), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

/** Backend alert webhook: `X-Selio-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, raw body)>`. */
export function verifySelioSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  return matches(header, `sha256=${hmacHex(secret, body)}`);
}

/** Dynamic event webhooks: `x-dynamic-signature-256: sha256=<hex HMAC-SHA256(webhook secret, raw body)>`. */
export function verifyDynamicEventSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  return matches(header, `sha256=${hmacHex(secret, body)}`);
}

/** Dynamic Transaction Review: `x-dynamic-signature: <hex HMAC-SHA256(review secret, raw body)>`. */
export function verifyReviewSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  return matches(header, hmacHex(secret, body));
}

/** Base64 Ed25519 signature of the exact response bytes, sent as `x-dynamic-response-signature`. */
export function signReviewResponse(key: KeyObject, body: Buffer): string {
  return sign(null, body, key).toString("base64");
}
