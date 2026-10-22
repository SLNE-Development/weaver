import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packArchive, sha256, type ProtoFile } from "@weaver/core/archive";
import { fetchProtos, OUTPUT_MARKER } from "./fetch.js";
import { run } from "./cli.js";

interface StubArtifact {
  group: string;
  name: string;
  version: string;
  files: ProtoFile[];
  /** Overrides for tampering tests. */
  headerSha?: string;
  resolveSha?: string;
  archiveHost?: string;
  /** Builds the archiveUrl from the primary base url (relative, prefixed, ...). */
  archiveUrlFor?: (base: string) => string;
  /** The repository the server reports and serves the archive from (default "main"); a group name for group tests. */
  repository?: string;
}

interface Logged {
  method: string;
  path: string;
  raw?: string;
  query?: string;
  authorization?: string;
}

let server: Server;
let foreign: Server;
let foreignUrl: string;
let foreignRequests: Logged[];
let malformedResolve = false;
let resolveFailure: { status: number; body: unknown } | undefined;
let baseUrl: string;
let requests: Logged[];
let artifacts: StubArtifact[];
let archives: Map<string, Buffer>;
let work: string;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const coord = (a: StubArtifact): string => `${a.group}:${a.name}:${a.version}`;
const archivePath = (a: StubArtifact): string =>
  `/api/v1/repos/${a.repository ?? "main"}/artifacts/${a.group}/${a.name}/${a.version}/archive`;

beforeEach(async () => {
  requests = [];
  foreignRequests = [];
  malformedResolve = false;
  resolveFailure = undefined;
  artifacts = [];
  archives = new Map();
  work = await mkdtemp(join(tmpdir(), "weaver-cli-"));
  server = createServer((req, res) => {
    void (async () => {
      const [rawPath = "", query = ""] = (req.url ?? "").split("?");
      // The stub is also mounted under a /registry prefix.
      const path = rawPath.startsWith("/registry/") ? rawPath.slice("/registry".length) : rawPath;
      requests.push({ method: req.method ?? "", path, raw: rawPath, query, authorization: req.headers.authorization });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization === "Bearer bad") {
        json(401, { error: { code: "unauthorized", message: "Invalid API key" } });
        return;
      }
      if (req.method === "POST" && path === "/api/v1/resolve") {
        await readBody(req);
        if (resolveFailure) {
          json(resolveFailure.status, resolveFailure.body);
          return;
        }
        if (malformedResolve) {
          json(200, { artifacts: "nope" });
          return;
        }
        const out = [];
        for (const a of artifacts) {
          const archive = await packArchive(a.files);
          archives.set(archivePath(a), archive);
          out.push({
            repository: a.repository ?? "main",
            coordinate: coord(a),
            group: a.group,
            name: a.name,
            version: a.version,
            buildNumber: 1,
            sha256: a.resolveSha ?? sha256(archive),
            archiveUrl: a.archiveUrlFor ? a.archiveUrlFor(baseUrl) : `${a.archiveHost ?? baseUrl}${archivePath(a)}`,
          });
        }
        json(200, { artifacts: out, conflicts: [] });
        return;
      }
      const archive = archives.get(path);
      if (req.method === "GET" && archive) {
        const a = artifacts.find((x) => archivePath(x) === path) as StubArtifact;
        res.writeHead(200, {
          "content-type": "application/gzip",
          "x-weaver-sha256": a.headerSha ?? sha256(archive),
        });
        res.end(archive);
        return;
      }
      json(404, { error: { code: "not_found", message: "Not found" } });
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  foreign = createServer((req, res) => {
    foreignRequests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  foreignUrl = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => foreign.close(() => r()));
  await rm(work, { recursive: true, force: true });
});

const proto = (path: string, body = "syntax = \"proto3\";\n"): ProtoFile => ({ path, content: body });

function options(over: Partial<Parameters<typeof fetchProtos>[0]> = {}): Parameters<typeof fetchProtos>[0] {
  return {
    url: baseUrl,
    repositories: ["main"],
    dependencies: ["com.acme:a:1.0.0"],
    outDir: join(work, "out"),
    cacheDir: join(work, "cache"),
    ...over,
  };
}

async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === OUTPUT_MARKER) continue;
    if (e.isDirectory()) out.push(...(await tree(join(dir, e.name), `${prefix}${e.name}/`)));
    else out.push(`${prefix}${e.name}`);
  }
  return out.sort();
}

describe("fetchProtos", () => {
  it("writes the files of every resolved artifact with their paths intact", async () => {
    artifacts.push(
      { group: "com.acme", name: "a", version: "1.0.0", files: [proto("acme/a/a.proto", "A")] },
      { group: "com.acme", name: "b", version: "2.0.0", files: [proto("acme/b/b.proto", "B"), proto("acme/b/c.proto")] },
    );
    const result = await fetchProtos(options());
    expect(result).toEqual({ artifacts: 2, files: 3 });
    expect(await tree(join(work, "out"))).toEqual(["acme/a/a.proto", "acme/b/b.proto", "acme/b/c.proto"]);
    expect(await readFile(join(work, "out", "acme/a/a.proto"), "utf8")).toBe("A");
  });

  it("removes stale files left by a previous run", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await fetchProtos(options());
    await mkdir(join(work, "out", "old"), { recursive: true });
    await writeFile(join(work, "out", "old", "gone.proto"), "x");
    expect(await tree(join(work, "out"))).toEqual(["a.proto", "old/gone.proto"]);
    await fetchProtos(options());
    expect(await tree(join(work, "out"))).toEqual(["a.proto"]);
  });

  it("reuses the cached archive when the sha is unchanged", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await fetchProtos(options());
    const archiveRequests = (): number => requests.filter((r) => r.path.endsWith("/archive")).length;
    expect(archiveRequests()).toBe(1);
    await fetchProtos(options());
    expect(archiveRequests()).toBe(1);
    expect(requests.filter((r) => r.path === "/api/v1/resolve")).toHaveLength(2);
    expect((await readdir(join(work, "cache"))).some((f) => f.endsWith(".tar.gz"))).toBe(true);
  });

  it("re-downloads when a cached archive is corrupt", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await fetchProtos(options());
    const [cached] = await readdir(join(work, "cache"));
    await writeFile(join(work, "cache", cached as string), "garbage");
    await fetchProtos(options());
    expect(requests.filter((r) => r.path.endsWith("/archive"))).toHaveLength(2);
  });

  it("fails naming the coordinate when the archive sha differs from x-weaver-sha256", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")], headerSha: "0".repeat(64) });
    await expect(fetchProtos(options())).rejects.toThrow(/Checksum mismatch for com\.acme:a:1\.0\.0/);
  });

  it("fails naming the coordinate when the archive sha differs from the resolve sha", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")], resolveSha: "1".repeat(64) });
    await expect(fetchProtos(options())).rejects.toThrow(/Checksum mismatch for com\.acme:a:1\.0\.0/);
  });

  it("fails naming both artifacts when two share a path", async () => {
    artifacts.push(
      { group: "com.acme", name: "a", version: "1.0.0", files: [proto("shared/x.proto")] },
      { group: "com.acme", name: "b", version: "1.0.0", files: [proto("shared/x.proto")] },
    );
    await expect(fetchProtos(options())).rejects.toThrow(/shared\/x\.proto.*com\.acme:a:1\.0\.0.*com\.acme:b:1\.0\.0/);
  });

  it("fails naming both artifacts when paths collide case-insensitively", async () => {
    artifacts.push(
      { group: "com.acme", name: "a", version: "1.0.0", files: [proto("Shared/X.proto")] },
      { group: "com.acme", name: "b", version: "1.0.0", files: [proto("shared/x.proto")] },
    );
    await expect(fetchProtos(options())).rejects.toThrow(/com\.acme:a:1\.0\.0.*com\.acme:b:1\.0\.0.*case-insensitive/);
  });

  it.each([
    ["dir/a:b.proto", "illegal character"],
    ["dir/a*b.proto", "illegal character"],
    ["dir/a?.proto", "illegal character"],
    ["dir/a<b>.proto", "illegal character"],
    ['dir/a"b.proto', "illegal character"],
    ["dir/a|b.proto", "illegal character"],
    ["CON/x.proto", "reserved"],
    ["dir/nul.proto", "reserved"],
    ["dir/COM1/x.proto", "reserved"],
    ["dir./x.proto", "trailing"],
    ["dir /x.proto", "trailing"],
  ])("rejects the Windows-unsafe path %s", async (path, reason) => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto(path)] });
    await expect(fetchProtos(options())).rejects.toThrow(new RegExp(`com\\.acme:a:1\\.0\\.0.*${reason}`));
    await expect(readdir(join(work, "out"))).rejects.toThrow();
  });

  const oneArtifact = (extra: Partial<StubArtifact> = {}): StubArtifact => ({
    group: "com.acme",
    name: "a",
    version: "1.0.0",
    files: [proto("a.proto")],
    ...extra,
  });
  const archiveRequests = (): Logged[] => requests.filter((r) => r.path.endsWith("/archive"));

  it("never contacts a foreign archive origin and sends the token to the rebased path on the configured one", async () => {
    artifacts.push(oneArtifact({ archiveHost: foreignUrl }));
    await fetchProtos(options({ token: "secret" }));
    expect(foreignRequests).toHaveLength(0);
    expect(archiveRequests()).toHaveLength(1);
    expect(archiveRequests()[0]).toMatchObject({
      path: "/api/v1/repos/main/artifacts/com.acme/a/1.0.0/archive",
      authorization: "Bearer secret",
    });
  });

  it("treats a different host with the same port as foreign", async () => {
    artifacts.push(oneArtifact({ archiveHost: baseUrl.replace("127.0.0.1", "localhost") }));
    await fetchProtos(options({ token: "secret" }));
    expect(archiveRequests()).toHaveLength(1);
    expect(archiveRequests()[0]?.authorization).toBe("Bearer secret");
  });

  it("uses a same-origin absolute archiveUrl as given", async () => {
    artifacts.push(oneArtifact());
    await fetchProtos(options({ token: "secret" }));
    expect(archiveRequests()[0]).toMatchObject({ authorization: "Bearer secret" });
    expect(foreignRequests).toHaveLength(0);
  });

  it("resolves a relative archiveUrl against the configured url", async () => {
    artifacts.push(oneArtifact({ archiveUrlFor: () => archivePath(oneArtifact()) }));
    await fetchProtos(options({ token: "secret" }));
    expect(archiveRequests()[0]).toMatchObject({ authorization: "Bearer secret" });
  });

  it("keeps a path prefix of the configured url, including when rebasing a foreign archiveUrl", async () => {
    artifacts.push(oneArtifact({ archiveHost: foreignUrl }));
    await fetchProtos(options({ url: `${baseUrl}/registry`, token: "secret" }));
    expect(foreignRequests).toHaveLength(0);
    expect(requests.find((r) => r.path === "/api/v1/resolve")?.raw).toBe("/registry/api/v1/resolve");
    expect(archiveRequests()[0]).toMatchObject({
      raw: "/registry/api/v1/repos/main/artifacts/com.acme/a/1.0.0/archive",
      authorization: "Bearer secret",
    });
  });

  it("keeps the archiveUrl query (the pinned build) when using or rebasing it", async () => {
    artifacts.push(oneArtifact({ archiveUrlFor: (base) => `${base}${archivePath(oneArtifact())}?build=1` }));
    await fetchProtos(options({ token: "secret" }));
    expect(archiveRequests()[0]).toMatchObject({ query: "build=1" });

    requests.length = 0;
    artifacts.length = 0;
    artifacts.push(oneArtifact({ archiveUrlFor: () => `${foreignUrl}${archivePath(oneArtifact())}?build=1` }));
    await fetchProtos(options({ token: "secret", cacheDir: join(work, "cache-2") }));
    expect(foreignRequests).toHaveLength(0);
    expect(archiveRequests()[0]).toMatchObject({ query: "build=1", authorization: "Bearer secret" });
  });

  it("resolving through a group name downloads from the group's archive url", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("acme/a/a.proto", "A")], repository: "all" });
    const result = await fetchProtos(options({ repositories: ["all"] }));
    expect(result).toEqual({ artifacts: 1, files: 1 });
    const downloads = requests.filter((r) => r.method === "GET");
    expect(downloads.map((r) => r.path)).toEqual(["/api/v1/repos/all/artifacts/com.acme/a/1.0.0/archive"]);
    expect(await readFile(join(work, "out", "acme/a/a.proto"), "utf8")).toBe("A");
  });

  it("upstream_unavailable is printed as the server message", async () => {
    resolveFailure = {
      status: 502,
      body: { error: { code: "upstream_unavailable", message: "Upstream of up-mirror did not answer" } },
    };
    await expect(fetchProtos(options({ repositories: ["up-mirror"] }))).rejects.toMatchObject({
      name: "CliError",
      message: "Upstream of up-mirror did not answer",
    });
  });

  it("fails clearly on a malformed resolve response", async () => {
    malformedResolve = true;
    await expect(fetchProtos(options())).rejects.toThrow(/Malformed response from registry: artifacts/);
  });

  it("times out requests", async () => {
    const hang = createServer(() => undefined);
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
      await expect(fetchProtos(options({ url, timeoutMs: 150 }))).rejects.toThrow(/timed out/);
    } finally {
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  describe("output directory safety", () => {
    const outOf = (cwd: string, outDir: string, extra: Partial<Parameters<typeof fetchProtos>[0]> = {}) =>
      options({ cwd, outDir, cacheDir: join(work, "cache"), ...extra });

    beforeEach(async () => {
      artifacts.push(oneArtifact());
      await mkdir(join(work, "proj"), { recursive: true });
    });

    it("writes the marker file", async () => {
      await fetchProtos(options());
      expect(await readFile(join(work, "out", OUTPUT_MARKER), "utf8")).toContain("weaver");
    });

    it("refuses a non-empty directory without the marker and leaves it untouched", async () => {
      await mkdir(join(work, "out"), { recursive: true });
      await writeFile(join(work, "out", "precious.txt"), "keep");
      await expect(fetchProtos(options())).rejects.toThrow(/wasn't created by weaver; remove it or choose another outDir/);
      expect(await readFile(join(work, "out", "precious.txt"), "utf8")).toBe("keep");
    });

    it("accepts an existing empty directory", async () => {
      await mkdir(join(work, "out"), { recursive: true });
      await expect(fetchProtos(options())).resolves.toEqual({ artifacts: 1, files: 1 });
    });

    it("uses the cwd passed in, not the process cwd", async () => {
      await expect(fetchProtos(outOf(join(work, "proj"), join(work, "proj")))).rejects.toThrow(/working directory/);
      await expect(fetchProtos(outOf(join(work, "proj"), work))).rejects.toThrow(/working directory/);
    });

    it("resolves relative outDir against the passed cwd", async () => {
      await fetchProtos(outOf(join(work, "proj"), "gen"));
      expect(await tree(join(work, "proj", "gen"))).toEqual(["a.proto"]);
    });

    it("resolves symlinks before comparing", async () => {
      const link = join(work, "link");
      await symlink(join(work, "proj"), link, "junction");
      await expect(fetchProtos(outOf(join(work, "proj"), link))).rejects.toThrow(/working directory/);
    });

    it("refuses an outDir containing the config file", async () => {
      await mkdir(join(work, "cfg"), { recursive: true });
      await expect(
        fetchProtos(outOf(join(work, "proj"), join(work, "cfg"), { configPath: join(work, "cfg", "weaver.json") })),
      ).rejects.toThrow(/config file/);
    });

    it("refuses an outDir containing the cache directory", async () => {
      await expect(
        fetchProtos(outOf(join(work, "proj"), work, { cwd: join(work, "proj"), cacheDir: join(work, "cache") })),
      ).rejects.toThrow(/cache directory|working directory/);
      await expect(
        fetchProtos(outOf(join(work, "proj"), join(work, "cache-parent"), { cacheDir: join(work, "cache-parent", "c") })),
      ).rejects.toThrow(/cache directory/);
    });

    it("refuses node_modules as outDir", async () => {
      await mkdir(join(work, "proj", "node_modules"), { recursive: true });
      await expect(fetchProtos(outOf(join(work, "proj"), "node_modules"))).rejects.toThrow(/node_modules/);
    });

    it("keeps the previous output intact when the final swap fails", async () => {
      await fetchProtos(options());
      artifacts[0] = oneArtifact({ files: [proto("new.proto")] });
      const out = join(work, "out");
      const failing = (async (from: string, to: string) => {
        if (to === out) throw new Error("EBUSY simulated");
        await rename(from, to);
      }) as typeof rename;
      await expect(fetchProtos(options({ renameFn: failing }))).rejects.toThrow(/EBUSY simulated/);
      expect(await tree(out)).toEqual(["a.proto"]);
      expect((await readdir(work)).filter((n) => n.startsWith("out.")).length).toBe(0);
    });
  });
});

describe("run", () => {
  function capture(): { io: { out: (s: string) => void; err: (s: string) => void }; err: string[] } {
    const err: string[] = [];
    return { io: { out: () => undefined, err: (s) => err.push(s) }, err };
  }

  it("prints the server error message and returns exit code 1 on 401", async () => {
    await writeFile(
      join(work, "weaver.json"),
      JSON.stringify({ url: baseUrl, repositories: ["main"], dependencies: ["com.acme:a:1.0.0"] }),
    );
    const { io, err } = capture();
    const code = await run(
      ["fetch", "--config", join(work, "weaver.json"), "--out", join(work, "out")],
      { WEAVER_TOKEN: "bad" },
      io,
      work,
    );
    expect(code).toBe(1);
    expect(err.join("")).toContain("Invalid API key");
    expect(err.join("")).not.toMatch(/\n\s+at /);
  });

  it("lets WEAVER_URL override the config url and fetches successfully", async () => {
    artifacts.push({ group: "com.acme", name: "a", version: "1.0.0", files: [proto("a.proto")] });
    await writeFile(
      join(work, "weaver.json"),
      JSON.stringify({ url: "http://127.0.0.1:1", repositories: ["main"], dependencies: ["com.acme:a:1.0.0"] }),
    );
    const { io } = capture();
    const code = await run(
      ["fetch", "--config", join(work, "weaver.json"), "--out", join(work, "out")],
      { WEAVER_URL: baseUrl },
      io,
      work,
    );
    expect(code).toBe(0);
    expect(await tree(join(work, "out"))).toEqual(["a.proto"]);
  });

  it("fails when neither the config nor WEAVER_URL provides a url", async () => {
    await writeFile(join(work, "weaver.json"), JSON.stringify({ repositories: [], dependencies: [] }));
    const { io, err } = capture();
    const code = await run(["fetch", "--config", join(work, "weaver.json")], {}, io, work);
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/WEAVER_URL/);
  });

  it("lists fetch in --help", async () => {
    const out: string[] = [];
    const code = await run(["--help"], {}, { out: (s) => out.push(s), err: () => undefined }, work);
    expect(code).toBe(0);
    expect(out.join("")).toContain("fetch");
  });
});
