import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request a fake server received. */
export interface SeenRequest {
  method: string;
  /** The path and query. */
  url: string;
  headers: IncomingHttpHeaders;
}

/** A local stand-in for a token-protected upstream registry (like Docker Hub), its token realm and its blob CDN; tests only. */
export interface FakeUpstream {
  /** The registry base URL, to configure as a mirror upstream. */
  url: string;
  /** The token realm the registry challenges with. */
  realmUrl: string;
  /** Every request the registry received, oldest first. */
  requests: SeenRequest[];
  /** Every token request the realm received, oldest first. */
  tokenRequests: SeenRequest[];
  /** Every request the CDN received, oldest first. */
  cdnRequests: SeenRequest[];
  /** Images whose every request answers 429. */
  rateLimited: Set<string>;
  /** Images whose every request answers 401 even with a valid token (Docker Hub's answer for a missing or private image). */
  locked: Set<string>;
  /**
   * Images that do not exist upstream, answered like Docker Hub: a request without a token gets the plain
   * challenge, one with a valid token `401` with `error="insufficient_scope"`. Like Hub, a token's access is
   * fixed when it is issued: a token issued while its image was missing keeps being refused after the image
   * appears.
   */
  missing: Set<string>;
  /** Stores a manifest under its digest (and `tag`, when given); resolves to the digest. */
  addManifest(image: string, tag: string | null, body: Buffer, mediaType: string): string;
  /** Stores a blob; `redirect` makes the registry answer 307 to the CDN for it. Resolves to the digest. */
  addBlob(image: string, data: Buffer, opts?: { redirect?: boolean }): string;
  /** Makes the registry answer `bytes` for `path` (e.g. `/v2/x/blobs/<digest>`) instead of the stored content. */
  tamper(path: string, bytes: Buffer): void;
  /** Requests the registry received for `path` (without query), any method. */
  hits(path: string): number;
  /** Clears the recorded requests. */
  reset(): void;
  /** Stops the servers. */
  close(): Promise<void>;
}

interface Stored {
  body: Buffer;
  mediaType: string;
}

function sha256(data: Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function record(req: { method?: string; url?: string; headers: IncomingHttpHeaders }): SeenRequest {
  return { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers };
}

/** Starts a {@link FakeUpstream}: tokens come from the realm (`expires_in` 300) and are bound to one `repository:<image>:pull` scope. */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const manifests = new Map<string, Map<string, Stored>>();
  const tags = new Map<string, Map<string, string>>();
  const blobs = new Map<string, Map<string, Buffer>>();
  const redirects = new Set<string>();
  const tampered = new Map<string, Buffer>();
  /** Issued tokens: their scope and whether they grant pull (decided at issue time). */
  const tokens = new Map<string, { scope: string; granted: boolean }>();
  const state = {
    requests: [] as SeenRequest[],
    tokenRequests: [] as SeenRequest[],
    cdnRequests: [] as SeenRequest[],
  };
  const rateLimited = new Set<string>();
  const locked = new Set<string>();
  const missing = new Set<string>();
  let realmUrl = "";
  let cdnUrl = "";

  const realm = createServer((req, res) => {
    state.tokenRequests.push(record(req));
    const scope = new URL(req.url ?? "/", "http://x").searchParams.get("scope") ?? "";
    const token = `tok-${state.tokenRequests.length}`;
    const image = /^repository:(.+):pull$/.exec(scope)?.[1];
    tokens.set(token, { scope, granted: image !== undefined && !missing.has(image) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token, expires_in: 300 }));
  });

  const cdn = createServer((req, res) => {
    state.cdnRequests.push(record(req));
    const digest = (req.url ?? "").split("/").pop() ?? "";
    for (const perImage of blobs.values()) {
      const data = perImage.get(digest);
      if (data) {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(data.length) });
        res.end(data);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });

  function send(res: import("node:http").ServerResponse, method: string, status: number, headers: Record<string, string>, body: Buffer): void {
    res.writeHead(status, { ...headers, "content-length": String(body.length) });
    res.end(method === "HEAD" ? undefined : body);
  }

  const notFound = (res: import("node:http").ServerResponse, method: string, code: string) =>
    send(res, method, 404, { "content-type": "application/json" }, Buffer.from(JSON.stringify({ errors: [{ code, message: "not found" }] })));

  const registry = createServer((req, res) => {
    state.requests.push(record(req));
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://x");
    const m = /^\/v2\/(.+)\/(manifests|blobs|tags|referrers)\/([^/]+)$/.exec(url.pathname);
    if (!m) return notFound(res, method, "NAME_UNKNOWN");
    const [, image, kind, arg] = m as unknown as [string, string, string, string];
    if (rateLimited.has(image)) {
      return send(res, method, 429, { "content-type": "application/json" }, Buffer.from('{"errors":[{"code":"TOOMANYREQUESTS"}]}'));
    }
    const scope = `repository:${image}:pull`;
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const issued = bearer ? tokens.get(bearer[1]!) : undefined;
    const valid = issued?.scope === scope;
    if (valid && (!issued.granted || missing.has(image))) {
      return send(
        res,
        method,
        401,
        {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="${realmUrl}",service="fake-registry",scope="${scope}",error="insufficient_scope"`,
        },
        Buffer.from('{"errors":[{"code":"UNAUTHORIZED"}]}'),
      );
    }
    if (locked.has(image) || !valid) {
      return send(
        res,
        method,
        401,
        {
          "content-type": "application/json",
          "www-authenticate": `Bearer realm="${realmUrl}",service="fake-registry",scope="${scope}"`,
        },
        Buffer.from('{"errors":[{"code":"UNAUTHORIZED"}]}'),
      );
    }
    const override = tampered.get(url.pathname);
    if (kind === "manifests") {
      const ref = decodeURIComponent(arg);
      const digest = ref.startsWith("sha256:") ? ref : tags.get(image)?.get(ref);
      const stored = digest ? manifests.get(image)?.get(digest) : undefined;
      if (!digest || !stored) return notFound(res, method, "MANIFEST_UNKNOWN");
      return send(
        res,
        method,
        200,
        { "content-type": stored.mediaType, "docker-content-digest": digest, etag: `"${digest}"`, "x-upstream-only": "1" },
        override ?? stored.body,
      );
    }
    if (kind === "blobs") {
      const data = blobs.get(image)?.get(arg);
      if (!data) return notFound(res, method, "BLOB_UNKNOWN");
      if (redirects.has(arg)) {
        res.writeHead(307, { location: `${cdnUrl}/blobs/${arg}`, "content-length": "0" });
        res.end();
        return;
      }
      return send(res, method, 200, { "content-type": "application/octet-stream", "docker-content-digest": arg }, override ?? data);
    }
    if (kind === "tags" && arg === "list") {
      const all = [...(tags.get(image)?.keys() ?? [])].sort();
      if (all.length === 0) return notFound(res, method, "NAME_UNKNOWN");
      const n = url.searchParams.get("n");
      const last = url.searchParams.get("last");
      let page = last ? all.filter((t) => t > last) : all;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (n !== null && page.length > Number(n)) {
        page = page.slice(0, Number(n));
        headers.link = `</v2/${image}/tags/list?n=${n}&last=${page[page.length - 1]}>; rel="next"`;
      }
      return send(res, method, 200, headers, Buffer.from(JSON.stringify({ name: image, tags: page })));
    }
    return notFound(res, method, "NAME_UNKNOWN");
  });

  const url = await listen(registry);
  realmUrl = `${await listen(realm)}/token`;
  cdnUrl = await listen(cdn);

  return {
    url,
    realmUrl,
    get requests() {
      return state.requests;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    get cdnRequests() {
      return state.cdnRequests;
    },
    rateLimited,
    locked,
    missing,
    addManifest(image, tag, body, mediaType) {
      const digest = sha256(body);
      if (!manifests.has(image)) manifests.set(image, new Map());
      manifests.get(image)!.set(digest, { body, mediaType });
      if (tag !== null) {
        if (!tags.has(image)) tags.set(image, new Map());
        tags.get(image)!.set(tag, digest);
      }
      return digest;
    },
    addBlob(image, data, opts = {}) {
      const digest = sha256(data);
      if (!blobs.has(image)) blobs.set(image, new Map());
      blobs.get(image)!.set(digest, data);
      if (opts.redirect) redirects.add(digest);
      return digest;
    },
    tamper(path, bytes) {
      tampered.set(path, bytes);
    },
    hits(path) {
      return state.requests.filter((r) => r.url.split("?")[0] === path).length;
    },
    reset() {
      state.requests = [];
      state.tokenRequests = [];
      state.cdnRequests = [];
    },
    async close() {
      await Promise.all(
        [registry, realm, cdn].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections();
            }),
        ),
      );
    },
  };
}
