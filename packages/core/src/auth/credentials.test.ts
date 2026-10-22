import { describe, expect, it } from "vitest";
import { extractToken } from "./credentials.js";

const h = (authorization?: string) => new Headers(authorization === undefined ? {} : { authorization });
const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

describe("extractToken", () => {
  it("reads a bearer token", () => {
    expect(extractToken(h("Bearer pl_abc"))).toBe("pl_abc");
    expect(extractToken(h("bearer pl_abc"))).toBe("pl_abc");
  });

  it("reads the password of a basic credential, whatever the user", () => {
    expect(extractToken(h(basic("someone:pl_tok")))).toBe("pl_tok");
    expect(extractToken(h(basic(":pl_tok")))).toBe("pl_tok");
    expect(extractToken(h(basic("a:b:c")))).toBe("b:c");
  });

  it("returns an empty string for empty or malformed credentials", () => {
    expect(extractToken(h("Bearer "))).toBe("");
    expect(extractToken(h("Bearer"))).toBe("");
    expect(extractToken(h("Basic"))).toBe("");
    expect(extractToken(h("Basic !!!not-base64"))).toBe("");
    expect(extractToken(h(basic("no-colon")))).toBe("");
    expect(extractToken(h(basic("user:")))).toBe("");
  });

  it("returns null without a bearer or basic header", () => {
    expect(extractToken(h())).toBeNull();
    expect(extractToken(h("Digest abc"))).toBeNull();
  });
});
