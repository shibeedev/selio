import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM under the 32-byte storage key, with a fresh 12-byte IV per record and `aad`
 * (the wallet id) as additional data. Stored as base64url(iv).base64url(ciphertext).base64url(tag).
 */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(".");
}

/** Reverses `seal`; throws on a malformed record or a tag mismatch (other key, ciphertext or `aad`). */
export function open(sealed: string, key: Buffer, aad: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 3) throw new Error("Malformed sealed record");
  const [iv, ciphertext, tag] = parts.map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("Malformed sealed record");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
