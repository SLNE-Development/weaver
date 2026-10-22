import { z } from "zod";
import {
  formatCoordinate,
  isValidGroup,
  isValidName,
  LIMITS,
  parseCoordinate,
  RegistryError,
  type FormatDeps,
  type FormatHandler,
  type Manifest,
  type Principal,
  type Registry,
} from "@weaver/core";
import {
  archiveUrl,
  buildParam,
  checkArtifactParams,
  errorResponse,
  forceParam,
  invalidRequest,
  json,
  readBodyLimited,
  readJson,
  versionCoordinate,
  type ArtifactParams,
  type VersionParams,
} from "./http.js";
import { createMirrorSource } from "./mirror-source.js";
import { createProtoService, type ProtoService } from "./service.js";
import { HOPS_HEADER, MAX_MIRROR_HOPS, SHA_HEADER, versionInfoToJson } from "./wire.js";

/** Largest resolve request body. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Room for the multipart framing and the manifest on top of the largest allowed archive. */
const MAX_PUBLISH_BODY = LIMITS.archiveBytes + 64 * 1024;

/** One `/api/v1` endpoint a path names, with its decoded path parameters. */
type Route =
  | { kind: "resolve" }
  | { kind: "versions"; params: ArtifactParams }
  | { kind: "version"; params: VersionParams }
  | { kind: "archive"; params: VersionParams };

/** The methods each endpoint answers, as sent in `allow` with a 405. */
const ALLOW: Record<Route["kind"], string> = {
  resolve: "POST",
  versions: "GET",
  version: "GET, PUT, DELETE",
  archive: "GET, HEAD",
};

/**
 * The endpoint `rest` names, or null for none. Segments are split on `/`, then percent-decoded;
 * a malformed escape is `invalid_request`.
 */
function routeOf(rest: string): Route | null {
  let segments: string[];
  try {
    segments = rest.split("/").map(decodeURIComponent);
  } catch {
    throw invalidRequest("Malformed percent-encoding in the request path");
  }
  if (segments.some((s) => s === "")) return null;
  if (segments.length === 1 && segments[0] === "resolve") return { kind: "resolve" };
  const [repos, repo, artifacts, group, name, version, archive, ...extra] = segments;
  if (repos !== "repos" || artifacts !== "artifacts" || repo === undefined || group === undefined || name === undefined) return null;
  if (extra.length > 0) return null;
  if (version === undefined) return { kind: "versions", params: { repo, group, name } };
  if (archive === undefined) return { kind: "version", params: { repo, group, name, version } };
  return archive === "archive" ? { kind: "archive", params: { repo, group, name, version } } : null;
}

/** The incoming `x-weaver-hops` count (0 without one); `invalid_request` when it is not a number. */
function hopsOf(req: Request): number {
  const raw = req.headers.get(HOPS_HEADER);
  if (raw === null) return 0;
  if (!/^\d{1,6}$/.test(raw.trim())) throw invalidRequest(`Invalid ${HOPS_HEADER} header "${raw}"`);
  return Number(raw.trim());
}

function isArtifactKey(s: string): boolean {
  const parts = s.split(":");
  return parts.length === 2 && isValidGroup(parts[0] as string) && isValidName(parts[1] as string);
}

const resolveBodySchema = z.object({
  repositories: z.array(z.string()).max(100),
  dependencies: z.array(z.string()).max(1000),
  exclude: z.array(z.string().refine(isArtifactKey, "Expected group:name")).max(1000).optional(),
});

/** Reads the `manifest` (JSON) and `archive` (file) fields of a multipart publish body. */
async function readPublishForm(req: Request): Promise<{ manifest: unknown; archive: Buffer }> {
  const body = await readBodyLimited(req, MAX_PUBLISH_BODY);
  let form: FormData;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalidRequest("Expected a multipart/form-data body with fields manifest and archive");
  }
  const manifestField = form.get("manifest");
  const archiveField = form.get("archive");
  if (typeof manifestField !== "string") throw invalidRequest("Missing multipart field manifest (JSON)");
  if (!(archiveField instanceof Blob)) throw invalidRequest("Missing multipart file field archive (tar.gz)");
  if (archiveField.size > LIMITS.archiveBytes) {
    throw new RegistryError("payload_too_large", `The archive exceeds ${LIMITS.archiveBytes} bytes`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestField) as unknown;
  } catch {
    throw invalidRequest("The manifest field must be valid JSON");
  }
  return { manifest, archive: Buffer.from(await archiveField.arrayBuffer()) };
}

/**
 * The `/api/v1` proto REST API over every proto repository kind; `rest` is the path after
 * "/api/v1/". Routes: `POST resolve`; `GET repos/<r>/artifacts/<g>/<n>` (versions);
 * `GET|PUT|DELETE repos/<r>/artifacts/<g>/<n>/<v>` (manifest, publish, delete);
 * `GET|HEAD repos/<r>/artifacts/<g>/<n>/<v>/archive[?build=]`. Any other path is `404 not_found`,
 * another method on a known path `405 method_not_allowed` with `allow`. A request that already
 * passed more than {@link MAX_MIRROR_HOPS} mirrors is refused as a mirror loop before any work.
 * Publishing and deleting go to `registry` (hosted repositories only); reads go through the
 * kind-aware proto service; publish validation runs inside `registry`.
 */
export function createProtoHandler(deps: FormatDeps & { registry: Registry }): FormatHandler {
  const service: ProtoService = createProtoService({
    registry: deps.registry,
    repos: deps.repos,
    mirrorSource: createMirrorSource({ mirror: deps.mirror }),
    usage: deps.usage,
  });

  async function resolve(req: Request, hops: number): Promise<Response> {
    const principal = await deps.principal(req);
    const parsed = resolveBodySchema.safeParse(await readJson(req, MAX_BODY_BYTES));
    if (!parsed.success) {
      throw invalidRequest("Invalid resolve request", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const { repositories, dependencies, exclude } = parsed.data;
    const roots = dependencies.map(parseCoordinate);
    const resolution = await service.resolve(principal, repositories, roots, { exclude: new Set(exclude) }, hops);
    return json({
      artifacts: resolution.nodes.map((node) => ({
        repository: node.repository,
        coordinate: formatCoordinate(node.coordinate),
        group: node.coordinate.group,
        name: node.coordinate.name,
        version: node.coordinate.version,
        buildNumber: node.buildNumber,
        sha256: node.sha256,
        archiveUrl: archiveUrl(deps.publicUrl, node.repository, node.coordinate, node.buildNumber),
      })),
      conflicts: resolution.conflicts,
    });
  }

  async function listVersions(req: Request, params: ArtifactParams, hops: number): Promise<Response> {
    checkArtifactParams(params);
    const principal = await deps.principal(req);
    const versions = await service.listVersions(principal, params.repo, params.group, params.name, hops);
    return json({ versions: versions.map((v) => ({ ...v, updatedAt: v.updatedAt.toISOString() })) });
  }

  async function getManifest(req: Request, params: VersionParams, hops: number): Promise<Response> {
    const c = versionCoordinate(params);
    const buildNumber = buildParam(req);
    const principal = await deps.principal(req);
    return json(versionInfoToJson(await service.getManifest(principal, params.repo, c, { buildNumber }, hops)));
  }

  async function publish(req: Request, params: VersionParams): Promise<Response> {
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_PUBLISH_BODY) {
      throw new RegistryError("payload_too_large", `Request body exceeds ${MAX_PUBLISH_BODY} bytes`);
    }
    const c = versionCoordinate(params);
    const principal: Principal = await deps.principal(req);
    if (principal.kind === "anonymous") throw new RegistryError("unauthorized", "Publishing requires an API key");

    const { manifest, archive } = await readPublishForm(req);
    const m = manifest as Partial<Manifest> | null;
    if (typeof m !== "object" || m === null || m.group !== c.group || m.name !== c.name || m.version !== c.version) {
      throw invalidRequest(`The manifest coordinate must equal the URL coordinate ${formatCoordinate(c)}`);
    }
    const result = await deps.registry.publish(principal, {
      repository: params.repo,
      manifest: manifest as Manifest,
      archive,
      force: forceParam(req),
    });
    return json(
      {
        coordinate: formatCoordinate(result.coordinate),
        buildNumber: result.buildNumber,
        sha256: result.sha256,
        redeployed: result.redeployed,
      },
      201,
    );
  }

  async function deleteVersion(req: Request, params: VersionParams): Promise<Response> {
    const c = versionCoordinate(params);
    const principal = await deps.principal(req);
    await deps.registry.deleteVersion(principal, params.repo, c, { force: forceParam(req) });
    return new Response(null, { status: 204 });
  }

  async function archive(req: Request, params: VersionParams, method: "GET" | "HEAD", hops: number): Promise<Response> {
    const c = versionCoordinate(params);
    const buildNumber = buildParam(req);
    const principal = await deps.principal(req);
    const got = await service.archive(principal, params.repo, c, { buildNumber }, method, hops);
    const headers = new Headers({
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${got.filename}"`,
      "cache-control": "private, no-store",
    });
    if (got.size !== null) headers.set("content-length", String(got.size));
    if (got.sha256 !== null) headers.set(SHA_HEADER, got.sha256);
    if (method === "HEAD") await got.body?.cancel().catch(() => undefined);
    return new Response(method === "HEAD" ? null : got.body, { status: 200, headers });
  }

  /** Writes to a version through a mirror or group: the registry refuses them, and only GET is left. */
  async function write(run: () => Promise<Response>): Promise<Response> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof RegistryError && error.code === "method_not_allowed") return errorResponse(error, { allow: "GET" });
      throw error;
    }
  }

  return async (req, rest) => {
    try {
      const hops = hopsOf(req);
      if (hops > MAX_MIRROR_HOPS) throw new RegistryError("not_found", "Mirror loop detected");
      const route = routeOf(rest);
      if (route === null) throw new RegistryError("not_found", "No such /api/v1 endpoint");
      const method = req.method.toUpperCase();
      switch (route.kind) {
        case "resolve":
          if (method === "POST") return await resolve(req, hops);
          break;
        case "versions":
          if (method === "GET") return await listVersions(req, route.params, hops);
          break;
        case "version":
          if (method === "GET") return await getManifest(req, route.params, hops);
          if (method === "PUT") return await write(() => publish(req, route.params));
          if (method === "DELETE") return await write(() => deleteVersion(req, route.params));
          break;
        case "archive":
          if (method === "GET" || method === "HEAD") return await archive(req, route.params, method, hops);
          break;
      }
      return errorResponse(new RegistryError("method_not_allowed", `${method} is not allowed here`), { allow: ALLOW[route.kind] });
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      throw error;
    }
  };
}
