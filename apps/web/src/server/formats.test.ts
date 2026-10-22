import { describe, expect, it, vi } from "vitest";
import type { FormatFactory } from "@weaver/core";
import config from "../../next.config";
import { config as proxyConfig } from "../proxy";
import { FACTORIES, getFormatHandler, mountRest } from "./formats";

// A server context without a database: every repository lookup misses.
vi.mock("./context", () => ({
  getServerContext: () => ({
    db: {},
    stores: { primary: { id: "local" }, configured: () => ["local"] },
    repos: { get: async () => null },
    registry: { hosted: {} },
    // No session: every request without a token is anonymous.
    auth: { api: { getSession: async () => null } },
    assets: {},
    mirror: {},
    secretKey: Buffer.alloc(32, 1),
  }),
}));

const req = (path: string) => new Request(`http://localhost:3000${path}`);

describe("mountRest", () => {
  it("extracts the raw path", () => {
    expect(mountRest(req("/npm/repo/@scope%2fpkg"), "npm")).toBe("repo/@scope%2fpkg");
  });
  it("maps /v2/ and /v2 to the empty string", () => {
    expect(mountRest(req("/v2/"), "docker")).toBe("");
    expect(mountRest(req("/v2"), "docker")).toBe("");
  });
  it("keeps a trailing slash", () => {
    expect(mountRest(req("/maven/r/a/"), "maven")).toBe("r/a/");
  });
  it('rest for /api/v1/repos/r/artifacts/g/n is "repos/r/artifacts/g/n"', () => {
    expect(mountRest(req("/api/v1/repos/r/artifacts/g/n"), "proto")).toBe("repos/r/artifacts/g/n");
    expect(mountRest(req("/api/v1/repos/r/artifacts/a%2Fb/n"), "proto")).toBe("repos/r/artifacts/a%2Fb/n");
  });
});

describe("proto mount", () => {
  it("getFormatHandler(\"proto\") answers /api/v1/resolve", async () => {
    const res = await getFormatHandler("proto")(
      new Request("http://localhost:3000/api/v1/resolve", {
        method: "POST",
        body: JSON.stringify({ repositories: ["missing"], dependencies: [] }),
      }),
      "resolve",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ artifacts: [], conflicts: [] });
  });

  it("answers an unknown repository with 404 not_found", async () => {
    const res = await getFormatHandler("proto")(req("/api/v1/repos/missing/artifacts/acme/money"), "repos/missing/artifacts/acme/money");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("maven mount", () => {
  it("maven mount is served by the maven handler", async () => {
    const res = await getFormatHandler("maven")(req("/maven/does-not-exist/x"), "does-not-exist/x");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});

describe("npm mount", () => {
  it("builds the real npm handler from deps carrying the secret key; a missing repo answers 404 JSON", async () => {
    let seen: Buffer | undefined;
    const original = FACTORIES.npm!;
    const factory: FormatFactory = (deps) => {
      seen = deps.secretKey;
      return original(deps);
    };
    FACTORIES.npm = factory;
    let handler;
    try {
      handler = getFormatHandler("npm");
    } finally {
      FACTORIES.npm = original;
    }
    expect(seen?.length).toBe(32);
    const res = await handler(req("/npm/x/-/ping"), "x/-/ping");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("routing config", () => {
  it("skips the trailing-slash redirect", () => {
    expect(config.skipTrailingSlashRedirect).toBe(true);
  });
  it("keeps the proxy off the protocol mounts", () => {
    const re = new RegExp(`^${proxyConfig.matcher[0]!}$`);
    for (const p of ["/v2/x", "/v2/", "/v2", "/maven/x", "/npm/x"]) expect(re.test(p)).toBe(false);
    expect(re.test("/repositories")).toBe(true);
  });
});
