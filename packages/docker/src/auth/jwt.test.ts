import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSecretKey } from "@weaver/core";
import { parseScopes, signToken, tokenKey, verifyToken, type DockerClaims } from "./jwt.js";

const key = tokenKey(deriveSecretKey("jwt-test"));
const now = new Date("2026-10-22T12:00:00Z");
const iat = Math.floor(now.getTime() / 1000);

function claims(overrides: Partial<DockerClaims> = {}): DockerClaims {
  return {
    iss: "weaver",
    aud: "weaver.test",
    sub: "anonymous",
    iat,
    nbf: iat,
    exp: iat + 300,
    jti: "j1",
    access: [{ type: "repository", name: "pub/app", actions: ["pull"] }],
    wv: { kind: "anonymous" },
    ...overrides,
  };
}

describe("docker jwt", () => {
  it("round trip", () => {
    const c = claims({ sub: "u1", wv: { kind: "apikey", userId: "u1", keyId: "k1", role: "maintainer" } });
    expect(verifyToken(key, signToken(key, c), "weaver.test", now)).toEqual(c);
  });

  it("tampered signature → null", () => {
    const token = signToken(key, claims());
    const [h, p, s] = token.split(".") as [string, string, string];
    const flipped = s.slice(0, -2) + (s.endsWith("AA") ? "BB" : "AA");
    expect(verifyToken(key, `${h}.${p}.${flipped}`, "weaver.test", now)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...claims(), access: [{ type: "repository", name: "priv/app", actions: ["push"] }] })).toString("base64url");
    expect(verifyToken(key, `${h}.${forged}.${s}`, "weaver.test", now)).toBeNull();
    expect(verifyToken(key, "not-a-jwt", "weaver.test", now)).toBeNull();
  });

  it("expired (exp+31 s) → null", () => {
    const token = signToken(key, claims());
    expect(verifyToken(key, token, "weaver.test", new Date((iat + 331) * 1000))).toBeNull();
  });

  it("exp has no leeway: valid at exp, null one second later", () => {
    const token = signToken(key, claims());
    expect(verifyToken(key, token, "weaver.test", new Date((iat + 300) * 1000))).not.toBeNull();
    expect(verifyToken(key, token, "weaver.test", new Date((iat + 301) * 1000))).toBeNull();
  });

  it('alg "none" and "RS256" tokens → null', () => {
    const payload = Buffer.from(JSON.stringify(claims())).toString("base64url");
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const rs = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const sig = signToken(key, claims()).split(".")[2]!;
    expect(verifyToken(key, `${none}.${payload}.`, "weaver.test", now)).toBeNull();
    expect(verifyToken(key, `${none}.${payload}.${sig}`, "weaver.test", now)).toBeNull();
    expect(verifyToken(key, `${rs}.${payload}.${sig}`, "weaver.test", now)).toBeNull();
  });

  it("nbf in the future beyond the leeway → null", () => {
    const token = signToken(key, claims({ nbf: iat + 31 }));
    expect(verifyToken(key, token, "weaver.test", now)).toBeNull();
    expect(verifyToken(key, signToken(key, claims({ nbf: iat + 30 })), "weaver.test", now)).not.toBeNull();
  });

  it("wrong audience → null", () => {
    expect(verifyToken(key, signToken(key, claims()), "other.test", now)).toBeNull();
  });

  it("another key → null", () => {
    const other = tokenKey(deriveSecretKey("jwt-test-2"));
    expect(verifyToken(other, signToken(key, claims()), "weaver.test", now)).toBeNull();
  });

  it("key differs from deriveSecretKey output for another info", () => {
    const secret = deriveSecretKey("jwt-test");
    expect(key).toHaveLength(32);
    expect(key.equals(secret)).toBe(false);
    const other = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "weaver-other", 32));
    expect(key.equals(other)).toBe(false);
    const same = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), "weaver-docker-token", 32));
    expect(key.equals(same)).toBe(true);
  });
});

describe("parseScopes", () => {
  it("parses repeated and space-separated scopes and merges actions per name", () => {
    expect(
      parseScopes(["repository:a/b:pull", "repository:c/d:pull,push repository:a/b:push registry:catalog:*", "x"]),
    ).toEqual([
      { type: "repository", name: "a/b", actions: ["pull", "push"] },
      { type: "repository", name: "c/d", actions: ["pull", "push"] },
    ]);
  });

  it("maps * to every action and drops unknown actions", () => {
    expect(parseScopes(["repository:a/b:*", "repository:c/d:frob"])).toEqual([
      { type: "repository", name: "a/b", actions: ["pull", "push", "delete"] },
    ]);
  });
});
