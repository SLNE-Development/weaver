import { describe, expect, it, vi } from "vitest";
import { RegistryError } from "./errors.js";

describe("RegistryError", () => {
  it("carries code, status and details", () => {
    const error = new RegistryError("has_dependents", "blocked", { n: 1 });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RegistryError);
    expect(error).toMatchObject({ code: "has_dependents", status: 409, details: { n: 1 }, name: "RegistryError" });
  });

  it("maps upstream_unavailable to 502", () => {
    expect(new RegistryError("upstream_unavailable", "down").status).toBe(502);
  });

  it("maps method_not_allowed to 405", () => {
    expect(new RegistryError("method_not_allowed", "read-only").status).toBe(405);
  });

  it("is recognised across copies of the module (separate server bundles)", async () => {
    // A second, independent instance of the module, as a different bundle would load it.
    vi.resetModules();
    const other = await import("./errors.js");
    expect(other.RegistryError).not.toBe(RegistryError);
    const foreign = new other.RegistryError("not_found", "missing");
    expect(foreign instanceof RegistryError).toBe(true);
    expect(new RegistryError("forbidden", "no") instanceof other.RegistryError).toBe(true);
  });

  it("doesn't match plain errors", () => {
    expect(new Error("x") instanceof RegistryError).toBe(false);
    expect((null as unknown as object) instanceof RegistryError).toBe(false);
    expect({ name: "RegistryError" } instanceof RegistryError).toBe(false);
  });
});
