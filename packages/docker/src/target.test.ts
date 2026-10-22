import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { CreateRepoInput } from "@weaver/core";
import { DockerError } from "./errors.js";
import { resolveTarget } from "./target.js";
import { startDockerTestRegistry, type DockerTestRegistry } from "./testing.js";

describe("resolveTarget", () => {
  let reg: DockerTestRegistry;
  beforeAll(async () => {
    reg = await startDockerTestRegistry();
  });
  afterAll(async () => {
    await reg?.stop();
  });

  async function reset(): Promise<void> {
    await reg.deps.db.execute(sql`TRUNCATE repository, usage_event, audit_event CASCADE`);
  }
  const hub: CreateRepoInput = {
    name: "hub",
    format: "docker",
    kind: "mirror",
    dockerRoot: true,
    upstreams: [{ url: "https://registry.example", authType: "none" }],
  };

  it("docker repo by first segment", async () => {
    await reset();
    const hosted = await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    const t = await resolveTarget(reg.deps.repos, "hosted/app");
    expect(t).toMatchObject({ image: "app", name: "hosted/app" });
    expect(t?.repo.id).toBe(hosted.id);
  });
  it("non-docker repo name falls through to root", async () => {
    await reset();
    await reg.createRepo({ name: "foo", format: "maven", kind: "hosted" });
    const root = await reg.createRepo(hub);
    const t = await resolveTarget(reg.deps.repos, "foo/bar");
    expect(t?.repo.id).toBe(root.id);
    expect(t?.image).toBe("foo/bar");
  });
  it("library/nginx goes to root", async () => {
    await reset();
    const root = await reg.createRepo(hub);
    const t = await resolveTarget(reg.deps.repos, "library/nginx");
    expect(t).toMatchObject({ image: "library/nginx", name: "library/nginx" });
    expect(t?.repo.id).toBe(root.id);
  });
  it("no root gives null", async () => {
    await reset();
    expect(await resolveTarget(reg.deps.repos, "library/nginx")).toBeNull();
  });
  it("repo segment alone is NAME_INVALID", async () => {
    await reset();
    await reg.createRepo({ name: "hosted", format: "docker", kind: "hosted" });
    await expect(resolveTarget(reg.deps.repos, "hosted")).rejects.toMatchObject({ code: "NAME_INVALID" });
    await expect(resolveTarget(reg.deps.repos, "hosted")).rejects.toBeInstanceOf(DockerError);
  });
});
