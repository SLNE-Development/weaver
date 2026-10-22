import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegistryError, type Registry, type VersionInfo } from "@weaver/core";
import type { ServerContext } from "@/server/context";
import { GET } from "./artifact/[repo]/[group]/[name]/[version]/route";

const registry = vi.hoisted(() => ({
  listVersions: vi.fn(),
  getManifest: vi.fn(),
}));

vi.mock("@/server/context", () => ({
  getServerContext: () => ({ registry: registry as unknown as Registry }) as unknown as ServerContext,
}));

const PUBLIC_INFO: Partial<VersionInfo> = {
  repository: "releases",
  coordinate: { group: "dev.surf.economy", name: "economy-contracts", version: "1.4.0" },
  buildNumber: 1,
  files: ["surf/economy/v1/money.proto"],
  dependencies: [],
};

function call(repo: string, group: string, name: string, version: string) {
  return GET(new Request(`http://localhost:3000/og/artifact/${repo}/${group}/${name}/${version}`), {
    params: Promise.resolve({ repo, group, name, version }),
  });
}

describe("GET /og/artifact/...", () => {
  beforeEach(() => {
    registry.getManifest.mockReset();
    registry.getManifest.mockImplementation((_p: unknown, repo: string) =>
      repo === "releases"
        ? Promise.resolve(PUBLIC_INFO)
        : Promise.reject(new RegistryError("not_found", `Repository ${repo} was not found`)),
    );
  });

  it("reads as an anonymous visitor", async () => {
    await call("internal", "dev.secret", "hidden-contracts", "1.0.0");
    expect(registry.getManifest).toHaveBeenCalledWith({ kind: "anonymous" }, "internal", {
      group: "dev.secret",
      name: "hidden-contracts",
      version: "1.0.0",
    });
  });

  it("answers public and private artifacts with the same status, type and short Cache-Control", async () => {
    const pub = await call("releases", "dev.surf.economy", "economy-contracts", "1.4.0");
    const priv = await call("internal", "dev.secret", "hidden-contracts", "1.0.0");
    for (const response of [pub, priv]) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=300");
    }
    expect([...priv.headers.keys()].sort()).toEqual([...pub.headers.keys()].sort());
  });

  it("serves the same generic card bytes for every private or unknown artifact", async () => {
    const a = Buffer.from(await (await call("internal", "dev.secret", "hidden-contracts", "1.0.0")).arrayBuffer());
    const b = Buffer.from(await (await call("nope", "x", "y", "2.0.0")).arrayBuffer());
    expect(a.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(a.equals(b)).toBe(true);
  });
});
