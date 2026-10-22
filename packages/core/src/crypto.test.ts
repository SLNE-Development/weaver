import { describe, expect, it } from "vitest";
import { decryptSecret, deriveSecretKey, encryptSecret } from "./crypto.js";

const SECRET = "a-server-secret-of-at-least-32-chars!";

describe("secret encryption", () => {
  it("derives a 32-byte key deterministically", () => {
    expect(deriveSecretKey(SECRET)).toHaveLength(32);
    expect(deriveSecretKey(SECRET).equals(deriveSecretKey(SECRET))).toBe(true);
  });

  it("round-trips a plaintext", () => {
    const key = deriveSecretKey(SECRET);
    const sealed = encryptSecret(key, "hunter2 ü\u{1F512}");
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
    expect(decryptSecret(key, sealed)).toBe("hunter2 ü\u{1F512}");
  });

  it("produces different output for the same plaintext", () => {
    const key = deriveSecretKey(SECRET);
    expect(encryptSecret(key, "same")).not.toBe(encryptSecret(key, "same"));
  });

  it("throws when a ciphertext byte is flipped", () => {
    const key = deriveSecretKey(SECRET);
    const [v, iv, tag, ct] = encryptSecret(key, "payload").split(".");
    const bytes = Buffer.from(ct!, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    expect(() => decryptSecret(key, [v, iv, tag, bytes.toString("base64url")].join("."))).toThrow();
  });

  it("throws on a different server secret and on malformed input", () => {
    const sealed = encryptSecret(deriveSecretKey(SECRET), "payload");
    expect(() => decryptSecret(deriveSecretKey(`${SECRET}-other`), sealed)).toThrow();
    expect(() => decryptSecret(deriveSecretKey(SECRET), "garbage")).toThrow();
  });
});
