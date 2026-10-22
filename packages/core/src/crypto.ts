import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const HKDF_INFO = "weaver-upstream-credentials";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Derives the 32-byte AES key for upstream credentials from the server secret (HKDF-SHA256, info "weaver-upstream-credentials"). */
export function deriveSecretKey(serverSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", serverSecret, Buffer.alloc(0), HKDF_INFO, 32));
}

/** Encrypts `plaintext` with AES-256-GCM under a fresh random IV; returns `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Decrypts a value produced by `encryptSecret`; throws when it is malformed, tampered with, or sealed under another key. */
export function decryptSecret(key: Buffer, value: string): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Malformed encrypted secret");
  const iv = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("Malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
}
