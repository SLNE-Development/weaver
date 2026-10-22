import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { component } from "@weaver/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseMetadata } from "./metadata.js";
import { startMavenFixture, type MavenFixture } from "./testing/fixture.js";

const JAR = "org/example/lib/1.2.0/lib-1.2.0.jar";
const POM = "org/example/lib/1.2.0/lib-1.2.0.pom";

describe("maven hosted repositories", () => {
  let fx: MavenFixture;
  let token: string;

  beforeAll(async () => {
    fx = await startMavenFixture();
    await fx.createRepo({ name: "releases", format: "maven", kind: "hosted", config: { versionPolicy: "release", redeploy: false } });
    await fx.createRepo({ name: "snapshots", format: "maven", kind: "hosted", config: { versionPolicy: "snapshot" } });
    await fx.createRepo({ name: "mixed", format: "maven", kind: "hosted" });
    await fx.createRepo({ name: "empty", format: "maven", kind: "hosted" });
    await fx.createRepo({ name: "pub", format: "maven", kind: "hosted", visibility: "public" });
    token = await fx.token(["releases", "snapshots", "mixed", "empty", "pub"].map((repo) => ({ repo, access: "write" as const })));
  }, 120_000);

  afterAll(async () => {
    await fx?.stop();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** PUTs a body with the writer token. */
  const put = (path: string, body: string | Buffer) => fx.request("PUT", path, { token, body });
  /** GETs (or HEADs) with the writer token. */
  const get = (path: string, method = "GET") => fx.request(method, path, { token });
  /** The number of stored assets of a repository. */
  const assetCount = async (repo: string) => (await fx.deps.assets.list((await fx.repos.get(repo))!.id, "")).length;
  /** The component row of a coordinate in a repository. */
  const componentRow = async (repo: string, namespace: string, name: string, version: string) => {
    const id = (await fx.repos.get(repo))!.id;
    const [row] = await fx.deps.db
      .select()
      .from(component)
      .where(and(eq(component.repositoryId, id), eq(component.namespace, namespace), eq(component.name, name), eq(component.version, version)));
    return row;
  };

  it("deploys and reads back a jar", async () => {
    const bytes = Buffer.from("jar-bytes-1.2.0");
    expect((await put(`releases/${JAR}`, bytes)).status).toBe(201);

    const res = await get(`releases/${JAR}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);
    expect(res.headers.get("content-type")).toBe("application/java-archive");
    expect(res.headers.get("etag")).toBe(`"${createHash("sha1").update(bytes).digest("hex")}"`);

    const head = await get(`releases/${JAR}`, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it("creates a component org.example:lib:1.2.0", async () => {
    expect(await componentRow("releases", "org.example", "lib", "1.2.0")).toBeDefined();
  });

  it("GET counts one download", async () => {
    const jar = "mixed/org/example/counted/1.0/counted-1.0.jar";
    expect((await put(jar, "c")).status).toBe(201);
    expect((await get(jar, "HEAD")).status).toBe(200);
    expect((await get(jar)).status).toBe(200);
    expect((await componentRow("mixed", "org.example", "counted", "1.0"))!.downloadCount).toBe(1);
    expect((await get(`${jar}.sha1`)).status).toBe(200);
    expect((await componentRow("mixed", "org.example", "counted", "1.0"))!.downloadCount).toBe(1);
  });

  it("serves uploaded checksum as uploaded", async () => {
    expect((await put(`releases/${JAR}.sha1`, "deadbeef")).status).toBe(201);
    const res = await get(`releases/${JAR}.sha1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("deadbeef");
  });

  it("generates missing checksums", async () => {
    const pomBytes = Buffer.from("<project><modelVersion>4.0.0</modelVersion></project>");
    expect((await put(`releases/${POM}`, pomBytes)).status).toBe(201);
    for (const algo of ["md5", "sha1", "sha256", "sha512"]) {
      const res = await get(`releases/${POM}.${algo}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(createHash(algo).update(pomBytes).digest("hex"));
    }
  });

  it("does not generate checksums of checksums or signatures", async () => {
    expect((await put(`releases/org/example/lib/1.2.0/lib-1.2.0.jar.asc`, "sig")).status).toBe(201);
    expect((await get(`releases/org/example/lib/1.2.0/lib-1.2.0.jar.asc.sha1`)).status).toBe(404);
    expect((await get(`releases/${JAR}.sha1.md5`)).status).toBe(404);
  });

  it("release redeploy denied", async () => {
    const res = await put(`releases/${JAR}`, "second");
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(`${JAR} already exists and redeploy is disabled for releases`);

    await fx.repos.update(fx.admin, "releases", { config: { versionPolicy: "release", redeploy: true } });
    try {
      expect((await put(`releases/${JAR}`, "third")).status).toBe(201);
      expect(await (await get(`releases/${JAR}`)).text()).toBe("third");
    } finally {
      await fx.repos.update(fx.admin, "releases", { config: { versionPolicy: "release", redeploy: false } });
    }
  });

  it("PUT of artifact-level maven-metadata.xml and .sha1 answer 201 in a redeploy-denied repo", async () => {
    const before = await assetCount("releases");
    const xml = '<?xml version="1.0"?><metadata><groupId>org.example</groupId><artifactId>lib</artifactId><versioning><versions><version>1.2.0</version></versions></versioning></metadata>';
    for (let i = 0; i < 2; i++) {
      expect((await put("releases/org/example/lib/maven-metadata.xml", xml)).status).toBe(201);
      expect((await put("releases/org/example/lib/maven-metadata.xml.sha1", "abc")).status).toBe(201);
    }
    expect(await assetCount("releases")).toBe(before);
  });

  it("metadata uploads above 1 MiB answer 413", async () => {
    const res = await put("mixed/org/example/big/maven-metadata.xml", Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(res.status).toBe(413);
  });

  it("version policy", async () => {
    const snap = "org/example/policy/1.0-SNAPSHOT/policy-1.0-20261022.101010-1.jar";
    const rel = "org/example/policy/1.0/policy-1.0.jar";
    const denied = await put(`releases/${snap}`, "s");
    expect(denied.status).toBe(400);
    expect(await denied.text()).toBe("Repository releases does not accept SNAPSHOT versions");
    const onlySnap = await put(`snapshots/${rel}`, "r");
    expect(onlySnap.status).toBe(400);
    expect(await onlySnap.text()).toBe("Repository snapshots only accepts SNAPSHOT versions");
    expect((await put(`mixed/${snap}`, "s")).status).toBe(201);
    expect((await put(`mixed/${rel}`, "r")).status).toBe(201);
  });

  it("snapshots are overwritable", async () => {
    const path = "snapshots/org/example/over/1.0-SNAPSHOT/over-1.0-20261022.101010-1.jar";
    expect((await put(path, "one")).status).toBe(201);
    expect((await put(path, "two")).status).toBe(201);
    expect(await (await get(path)).text()).toBe("two");
  });

  it("artifact metadata lists versions", async () => {
    for (const v of ["1.0", "1.10", "1.9"]) {
      expect((await put(`mixed/org/example/lib/${v}/lib-${v}.jar`, v)).status).toBe(201);
    }
    expect((await put("mixed/org/example/lib/2.0-SNAPSHOT/lib-2.0-20261022.101010-1.jar", "s")).status).toBe(201);

    const res = await get("mixed/org/example/lib/maven-metadata.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml");
    const xml = await res.text();
    const parsed = parseMetadata(xml);
    expect(parsed?.kind).toBe("artifact");
    if (parsed?.kind !== "artifact") return;
    expect(parsed.value.versions).toEqual(["1.0", "1.9", "1.10", "2.0-SNAPSHOT"]);
    expect(xml).toContain("<release>1.10</release>");
    expect(xml).toContain("<latest>2.0-SNAPSHOT</latest>");
  });

  it("sha1 of GET maven-metadata.xml equals GET maven-metadata.xml.sha1", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const xml = await (await get("mixed/org/example/lib/maven-metadata.xml")).text();
    vi.setSystemTime(now + 5000);
    expect(Date.now()).toBeGreaterThanOrEqual(now + 5000);
    const sha1 = await (await get("mixed/org/example/lib/maven-metadata.xml.sha1")).text();
    expect(sha1).toBe(createHash("sha1").update(xml).digest("hex"));
  });

  it("snapshot metadata", async () => {
    const dir = "snapshots/org/example/lib/1.0-SNAPSHOT";
    for (const [stamp, build] of [["20261022.101010", 1], ["20261022.111111", 2]] as const) {
      const v = `1.0-${stamp}-${build}`;
      expect((await put(`${dir}/lib-${v}.jar`, `jar-${build}`)).status).toBe(201);
      expect((await put(`${dir}/lib-${v}.pom`, `pom-${build}`)).status).toBe(201);
      expect((await put(`${dir}/lib-${v}-sources.jar`, `src-${build}`)).status).toBe(201);
      expect((await put(`${dir}/lib-${v}.jar.sha1`, "abc")).status).toBe(201);
    }
    const res = await get(`${dir}/maven-metadata.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<buildNumber>2</buildNumber>");
    const parsed = parseMetadata(xml);
    expect(parsed?.kind).toBe("snapshot");
    if (parsed?.kind !== "snapshot") return;
    expect(parsed.value.latest).toEqual({ timestamp: "20261022.111111", buildNumber: 2 });
    expect(parsed.value.snapshotVersions).toHaveLength(3);
    for (const s of parsed.value.snapshotVersions) expect(s.value).toBe("1.0-20261022.111111-2");
    expect(parsed.value.snapshotVersions.map((s) => `${s.classifier ?? ""}:${s.extension}`).sort()).toEqual([":jar", ":pom", "sources:jar"]);
  });

  it("non-unique snapshot name serves newest build", async () => {
    const res = await get("snapshots/org/example/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT.jar");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("jar-2");
    const sources = await get("snapshots/org/example/lib/1.0-SNAPSHOT/lib-1.0-SNAPSHOT-sources.jar");
    expect(await sources.text()).toBe("src-2");
  });

  it(".asc and .module stored as-is", async () => {
    const asc = Buffer.from("-----BEGIN PGP SIGNATURE-----\nxyz\n-----END PGP SIGNATURE-----\n");
    const module = Buffer.from('{"formatVersion":"1.1"}');
    expect((await put("mixed/org/example/mod/1.0/mod-1.0.jar.asc", asc)).status).toBe(201);
    expect((await put("mixed/org/example/mod/1.0/mod-1.0.module", module)).status).toBe(201);
    expect(Buffer.from(await (await get("mixed/org/example/mod/1.0/mod-1.0.jar.asc")).arrayBuffer())).toEqual(asc);
    const res = await get("mixed/org/example/mod/1.0/mod-1.0.module");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(module);
  });

  it("plugin group metadata is stored", async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<metadata>\n  <plugins>\n    <plugin>\n      <name>Example</name>\n      <prefix>example</prefix>\n      <artifactId>example-maven-plugin</artifactId>\n    </plugin>\n  </plugins>\n</metadata>\n';
    expect((await put("mixed/org/example/maven-metadata.xml", xml)).status).toBe(201);
    const res = await get("mixed/org/example/maven-metadata.xml");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(xml);
    expect(await (await get("mixed/org/example/maven-metadata.xml.sha1")).text()).toBe(createHash("sha1").update(xml).digest("hex"));
  });

  it("PUT with traversal path answers 400 and stores nothing", async () => {
    expect((await put("empty/org/%2e%2e/x/1/x-1.jar", "x")).status).toBe(400);
    expect(await assetCount("empty")).toBe(0);
  });

  it("PUT on a directory answers 400", async () => {
    expect((await put("empty/org/example/", "x")).status).toBe(400);
  });

  it("paths outside the layout are stored without a component", async () => {
    expect((await put("mixed/archetype-catalog.xml", "<catalog/>")).status).toBe(201);
    expect(await (await get("mixed/archetype-catalog.xml")).text()).toBe("<catalog/>");
  });

  it("missing file answers 404", async () => {
    expect((await get("mixed/org/example/nope/1.0/nope-1.0.jar")).status).toBe(404);
    expect((await get("mixed/org/example/nope/1.0/nope-1.0.jar.sha1")).status).toBe(404);
    expect((await get("mixed/org/example/nope/maven-metadata.xml")).status).toBe(404);
  });

  it("a public repo allows an anonymous read", async () => {
    expect((await put("pub/org/example/open/1.0/open-1.0.jar", "open")).status).toBe(201);
    const res = await fx.request("GET", "pub/org/example/open/1.0/open-1.0.jar");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("open");
  });
});
