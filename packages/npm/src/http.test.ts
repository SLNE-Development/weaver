import { RegistryError } from "@weaver/core";
import { describe, expect, it, vi } from "vitest";
import { npmError, npmJson, toNpmResponse } from "./http.js";

describe("npm http helpers", () => {
  it("builds json and error responses", async () => {
    const ok = npmJson({ a: 1 });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/json");
    expect(await npmError(404, "nope").json()).toEqual({ error: "nope" });
  });
  it("maps registry errors and hides others", async () => {
    const r = toNpmResponse(new RegistryError("unauthorized", "login required"));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
    expect(await r.json()).toEqual({ error: "login required" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const e = toNpmResponse(new Error("boom"));
    expect(e.status).toBe(500);
    expect(await e.json()).toEqual({ error: "internal error" });
  });
});
