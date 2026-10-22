import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { digestsOf, makeTarball } from "./fixtures.js";

/** A running fake of registry.npmjs.org over node:http. */
export interface FakeRegistry {
  /** Base URL, without a trailing slash. */
  url: string;
  /** Raw request URLs (path and query) received, in order. */
  hits: string[];
  /** Every request received, in order, with its headers and the raw body bytes. */
  requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }>;
  /** While down, every request answers 503. */
  setOffline(down: boolean): void;
  /** Stops the server. */
  close(): Promise<void>;
}

const CORGI = "application/vnd.npm.install-v1+json";

/** One package the fake serves, with its tarballs built in advance. */
interface FakePackage {
  name: string;
  bare: string;
  versions: string[];
  tags: Record<string, string>;
  tarballs: Map<string, Buffer>;
}

/** The package name a request path addresses (`@s%2fn`, `@s/n` or `n`) and the rest of the path. */
function splitPath(pathname: string): { name: string; rest: string[] } | null {
  const segs = pathname.split("/").slice(1).map((s) => decodeURIComponent(s));
  const first = segs[0];
  if (!first) return null;
  if (first.startsWith("@") && !first.includes("/")) {
    if (segs[1] === undefined) return null;
    return { name: `${first}/${segs[1]}`, rest: segs.slice(2) };
  }
  return { name: first, rest: segs.slice(1) };
}

/**
 * Starts a fake npm registry serving full and abbreviated packuments (chosen by Accept), tarballs at
 * `<name>/-/<bare>-<version>.tgz`, `GET /-/v1/search` (paged by `size` and `from`) and `POST /-/npm/v1/security/*` (audit). With `gzip`, JSON
 * answers are gzip-encoded when the client accepts it.
 */
export async function startFakeRegistry(
  packages: Array<{ name: string; versions: string[]; tags?: Record<string, string> }>,
  opts: { gzip?: boolean } = {},
): Promise<FakeRegistry> {
  const byName = new Map<string, FakePackage>();
  for (const p of packages) {
    const bare = p.name.startsWith("@") ? p.name.slice(p.name.indexOf("/") + 1) : p.name;
    const tarballs = new Map<string, Buffer>();
    for (const v of p.versions) tarballs.set(`${bare}-${v}.tgz`, await makeTarball(p.name, v));
    byName.set(p.name, { name: p.name, bare, versions: p.versions, tags: { latest: p.versions[p.versions.length - 1]!, ...p.tags }, tarballs });
  }
  const hits: string[] = [];
  const requests: FakeRegistry["requests"] = [];
  let offline = false;
  let url = "";

  function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
    let data = Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": type };
    if (opts.gzip && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
      data = gzipSync(data);
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = String(data.length);
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  }

  function packument(p: FakePackage, abbreviated: boolean): unknown {
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = { created: "2020-01-01T00:00:00.000Z" };
    p.versions.forEach((v, i) => {
      const tgz = p.tarballs.get(`${p.bare}-${v}.tgz`)!;
      const dist = { ...digestsOf(tgz), tarball: `${url}/${p.name}/-/${p.bare}-${v}.tgz` };
      versions[v] = abbreviated ? { name: p.name, version: v, dist } : { name: p.name, version: v, description: `the ${p.name} package`, _id: `${p.name}@${v}`, dist };
      time[v] = `2020-01-0${Math.min(i + 2, 9)}T00:00:00.000Z`;
    });
    time["modified"] = time[p.versions[p.versions.length - 1]!] ?? time["created"]!;
    if (abbreviated) return { name: p.name, modified: time["modified"], "dist-tags": p.tags, versions };
    return { _id: p.name, _rev: "3-0123456789abcdef", name: p.name, description: `the ${p.name} package`, readme: `# ${p.name}`, "dist-tags": p.tags, versions, time };
  }

  const server = createServer((req, res) => {
    const raw = req.url ?? "/";
    hits.push(raw);
    // Read the whole request body before answering.
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", url: raw, headers: req.headers, body: Buffer.concat(chunks) });
      answer(req, res, raw);
    });
  });

  function answer(req: IncomingMessage, res: ServerResponse, raw: string): void {
    if (offline) return sendJson(req, res, 503, { error: "service unavailable" });
    const { pathname, searchParams } = new URL(raw, "http://fake");
    if (pathname === "/-/v1/search") {
      const text = searchParams.get("text") ?? "";
      const size = Number(searchParams.get("size") ?? "20");
      const from = Number(searchParams.get("from") ?? "0");
      const all = [...byName.values()]
        .filter((p) => p.name.includes(text))
        .map((p) => ({ package: { name: p.name, version: p.tags["latest"] }, score: { final: 1 }, searchScore: 1 }));
      return sendJson(req, res, 200, { objects: all.slice(from, from + size), total: all.length, time: new Date(0).toUTCString() });
    }
    if (pathname.startsWith("/-/npm/v1/security/")) {
      return req.method === "POST" ? sendJson(req, res, 200, {}) : sendJson(req, res, 405, { error: "method not allowed" });
    }
    const split = splitPath(pathname);
    const p = split ? byName.get(split.name) : undefined;
    if (!split || !p) return sendJson(req, res, 404, { error: "Not found" });
    if (split.rest.length === 0) {
      const abbreviated = String(req.headers["accept"] ?? "").includes(CORGI);
      return sendJson(req, res, 200, packument(p, abbreviated), abbreviated ? CORGI : "application/json");
    }
    if (split.rest.length === 2 && split.rest[0] === "-") {
      const tgz = p.tarballs.get(split.rest[1]!);
      if (!tgz) return sendJson(req, res, 404, { error: "Not found" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(tgz.length) });
      res.end(req.method === "HEAD" ? undefined : tgz);
      return;
    }
    return sendJson(req, res, 404, { error: "Not found" });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    hits,
    requests,
    setOffline(down) {
      offline = down;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** The tarball the fake serves for `name@version`, built the same way. */
export function fakeTarball(name: string, version: string): Promise<Buffer> {
  return makeTarball(name, version);
}
