import { makeSignature } from "better-auth/crypto";

/**
 * Better Auth's signed session cookie value for `token`:
 * `encodeURIComponent(`${token}.${base64(HMAC-SHA256(secret, token))}`)`, exactly as Better Auth signs it.
 */
export async function signSessionCookie(secret: string, token: string): Promise<string> {
  return encodeURIComponent(`${token}.${await makeSignature(token, secret)}`);
}
