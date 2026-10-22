import { describe, expect, it, vi } from "vitest";
import { RegistryError } from "@weaver/core";
import { handle } from "./http";

describe("handle", () => {
  it("maps RegistryError to its status and body", async () => {
    const res = await handle(async () => {
      throw new RegistryError("validation_failed", "bad protos", { issues: [] });
    })();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "validation_failed", message: "bad protos", details: { issues: [] } } });
  });

  it("hides unknown errors behind a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handle(async () => {
      throw new Error("database password is hunter2");
    })();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).not.toContain("hunter2");
    expect(body.error.code).toBe("internal_error");
    spy.mockRestore();
  });
});
