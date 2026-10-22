import { afterEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "./index.js";
import { createDb } from "./index.js";

describe("createDb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs idle-client pool errors instead of crashing the process", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createDb("postgres://user:pass@127.0.0.1:1/none");
    const failure = new Error("terminating connection due to administrator command");

    expect(db.$client.listenerCount("error")).toBeGreaterThan(0);
    // Without a listener, EventEmitter#emit("error") throws, which crashes the process.
    expect(() => db.$client.emit("error", failure)).not.toThrow();
    expect(consoleError).toHaveBeenCalledWith("weaver: idle postgres client error", failure);
    await db.$client.end();
  });

  it("bounds the wait for a pool connection", async () => {
    const db = createDb("postgres://user:pass@127.0.0.1:1/none");
    expect(db.$client.options).toMatchObject({ max: 10, connectionTimeoutMillis: 30_000 });
    await db.$client.end();
    const small = createDb("postgres://user:pass@127.0.0.1:1/none", { max: 2, connectionTimeoutMillis: 500 });
    expect(small.$client.options).toMatchObject({ max: 2, connectionTimeoutMillis: 500 });
    await small.$client.end();
  });
});

describe("schema exports", () => {
  it("exposes the multi-format enums with their exact values", () => {
    expect(schema.repoFormatEnum.enumValues).toEqual(["maven", "npm", "docker", "proto"]);
    expect(schema.repoKindEnum.enumValues).toEqual(["hosted", "mirror", "group"]);
    expect(schema.visibilityEnum.enumValues).toEqual(["public", "private"]);
    expect(schema.accessEnum.enumValues).toEqual(["read", "write"]);
    expect(schema.upstreamAuthEnum.enumValues).toEqual(["none", "basic", "bearer"]);
    expect(schema.assetOriginEnum.enumValues).toEqual(["hosted", "cache"]);
    expect(schema.usageActionEnum.enumValues).toEqual(["download", "upload", "delete"]);
    expect(schema.cacheResultEnum.enumValues).toEqual(["hit", "miss", "bypass", "stale"]);
  });

  it("names the proto tables with a proto_ prefix", () => {
    const names = [
      schema.protoArtifact,
      schema.protoVersion,
      schema.protoBuild,
      schema.protoBuildFile,
      schema.protoDependency,
      schema.protoDeletedRelease,
    ].map((t) => getTableName(t));
    expect(names).toEqual([
      "proto_artifact",
      "proto_version",
      "proto_build",
      "proto_build_file",
      "proto_dependency",
      "proto_deleted_release",
    ]);
  });
});
