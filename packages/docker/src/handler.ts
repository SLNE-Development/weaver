import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryError, type FormatDeps, type FormatFactory, type FormatHandler } from "@weaver/core";
import { challenge, identify, requireAccess, scopeChallenge, scopeFor } from "./auth/authorize.js";
import type { DockerAction } from "./auth/jwt.js";
import { handleToken } from "./auth/token-endpoint.js";
import { DockerError, errorResponse } from "./errors.js";
import { fromGroup, type GroupOp } from "./group.js";
import { deleteHostedBlob, serveHostedBlob, type HostedCtx } from "./hosted/blobs.js";
import { blobUnknown } from "./hosted/blobs.js";
import { deleteManifest, manifestUnknown, putManifest, serveManifest } from "./hosted/manifests.js";
import { serveReferrers } from "./hosted/referrers.js";
import { serveTags } from "./hosted/tags.js";
import { cancelUpload, finishUpload, patchUpload, startUpload, uploadStatus } from "./hosted/uploads.js";
import { isDigest } from "./media-types.js";
import { createHubAuth } from "./mirror/hub-auth.js";
import { mirrorBlob, mirrorManifest, mirrorReferrers, mirrorTags, type MirrorCtx } from "./mirror/mirror.js";
import { parseRoute, type Route } from "./route.js";
import { resolveTarget, type Target } from "./target.js";

/** Settings of a docker handler. */
export interface DockerOptions {
  /** Directory where in-progress blob uploads are staged. */
  uploadDir: string;
  /** The clock, for tests. */
  now?: () => Date;
  /** Test hook: awaited after a finished upload's object is stored and before its blob row is upserted. */
  beforeBlobUpsert?: (digest: string, storageKey: string) => Promise<void>;
  /**
   * Test hook: awaited inside a manifest PUT's transaction when it starts (`begin`), after the row insert (`inserted`) and once the
   * manifest id is known, before the tag is written (`resolved`).
   */
  onManifestPutStep?: (step: "begin" | "inserted" | "resolved") => Promise<void>;
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps a thrown value to an OCI error response; unexpected errors are logged and become 500 `UNKNOWN`. */
function toResponse(err: unknown, publicUrl: string): Response {
  if (err instanceof DockerError) return errorResponse(err);
  if (err instanceof RegistryError) {
    switch (err.code) {
      case "unauthorized":
        return errorResponse(challenge(publicUrl));
      case "invalid_request":
        return errorResponse(new DockerError(400, "UNSUPPORTED", err.message));
      case "payload_too_large":
        return errorResponse(new DockerError(413, "SIZE_INVALID", err.message));
      case "forbidden":
        return errorResponse(new DockerError(403, "DENIED", err.message));
      case "not_found":
        return errorResponse(new DockerError(404, "NAME_UNKNOWN", err.message));
      case "upstream_unavailable":
        return errorResponse(new DockerError(502, "UNAVAILABLE", "upstream unavailable"));
    }
  }
  console.error("weaver:docker request failed", err);
  return errorResponse(new DockerError(500, "UNKNOWN", "internal error"));
}

/** Rejects digests and upload ids that are malformed, before any lookup. */
function validate(route: Route): void {
  if ((route.kind === "blob" || route.kind === "referrers") && !isDigest(route.digest)) {
    throw new DockerError(400, "DIGEST_INVALID", "invalid digest", { digest: route.digest });
  }
  if (route.kind === "upload" && !UPLOAD_ID.test(route.uploadId)) {
    throw new DockerError(404, "BLOB_UPLOAD_UNKNOWN", "unknown upload", { uploadId: route.uploadId });
  }
}

/** The typed error for a manifest path whose reference is neither a valid tag nor digest, or null when `rest` is not a manifest path. */
function invalidReference(rest: string): DockerError | null {
  const m = rest.match(/^.+\/manifests\/([^/]+)$/);
  if (!m) return null;
  const reference = m[1]!;
  return reference.includes(":")
    ? new DockerError(400, "DIGEST_INVALID", "invalid digest", { reference })
    : new DockerError(400, "MANIFEST_INVALID", "invalid manifest reference", { reference });
}

/** The docker action a request needs: every upload request pushes; otherwise reads pull, DELETE deletes, the rest pushes. */
function actionOf(method: string, route: Route): DockerAction {
  if (route.kind === "upload" || route.kind === "upload-start") return "push";
  if (method === "GET" || method === "HEAD") return "pull";
  return method === "DELETE" ? "delete" : "push";
}

function methodNotAllowed(method: string): DockerError {
  return new DockerError(405, "UNSUPPORTED", `method ${method} not allowed here`);
}

/** Serves the routes of a hosted repository: manifests, blobs, uploads, tags and referrers. */
function dispatchHosted(ctx: HostedCtx, req: Request, route: Route): Promise<Response> | null {
  const { method } = req;
  switch (route.kind) {
    case "manifest":
      if (method === "GET" || method === "HEAD") return serveManifest(ctx, req, route.reference);
      if (method === "PUT") return putManifest(ctx, req, route.reference);
      if (method === "DELETE") return deleteManifest(ctx, route.reference);
      throw methodNotAllowed(method);
    case "tags":
      if (method === "GET") return serveTags(ctx, req);
      throw methodNotAllowed(method);
    case "referrers":
      if (method === "GET") return serveReferrers(ctx, req, route.digest);
      throw methodNotAllowed(method);
    default:
      return dispatchHostedBlobs(ctx, req, route);
  }
}

/** Serves blob and upload routes of a hosted repository; null for routes it does not handle. */
function dispatchHostedBlobs(ctx: HostedCtx, req: Request, route: Route): Promise<Response> | null {
  const { method } = req;
  switch (route.kind) {
    case "blob":
      if (method === "GET" || method === "HEAD") return serveHostedBlob(ctx, req, route.digest);
      if (method === "DELETE") return deleteHostedBlob(ctx, route.digest);
      throw methodNotAllowed(method);
    case "upload-start":
      if (method === "POST") return startUpload(ctx, req);
      throw methodNotAllowed(method);
    case "upload":
      if (method === "PATCH") return patchUpload(ctx, req, route.uploadId);
      if (method === "PUT") return finishUpload(ctx, req, route.uploadId);
      if (method === "GET") return uploadStatus(ctx, route.uploadId);
      if (method === "DELETE") return cancelUpload(ctx, route.uploadId);
      throw methodNotAllowed(method);
    default:
      return null;
  }
}

/** A route that names an image. */
type NamedRoute = Exclude<Route, { kind: "base" } | { kind: "token" }>;

/** The `404` a read answers when no repository has the item. */
function notFound(route: NamedRoute): DockerError {
  switch (route.kind) {
    case "manifest":
      return manifestUnknown(route.reference);
    case "blob":
      return blobUnknown(route.digest);
    default:
      return new DockerError(404, "NAME_UNKNOWN", "repository name not known to registry", { name: route.name });
  }
}

/** The group operation and its argument for a read route, or null when the route and method are not a read. */
function readOf(method: string, route: NamedRoute): { op: GroupOp; arg: string } | null {
  const read = method === "GET" || method === "HEAD";
  if (route.kind === "manifest" && read) return { op: "manifest", arg: route.reference };
  if (route.kind === "blob" && read) return { op: "blob", arg: route.digest };
  if (route.kind === "tags" && method === "GET") return { op: "tags", arg: "" };
  if (route.kind === "referrers" && method === "GET") return { op: "referrers", arg: route.digest };
  return null;
}

/** Serves one read of a mirror repository. */
function fromMirror(ctx: MirrorCtx, op: GroupOp, req: Request, arg: string): Promise<Response | null> {
  switch (op) {
    case "manifest":
      return mirrorManifest(ctx, req, arg);
    case "blob":
      return mirrorBlob(ctx, req, arg);
    case "tags":
      return mirrorTags(ctx, req);
    case "referrers":
      return mirrorReferrers(ctx, req, arg);
  }
}

/** Serves the read routes of a mirror or group repository (writes were refused by `requireAccess`); a miss is the route's `404`. */
async function dispatchReadOnly(ctx: MirrorCtx, req: Request, route: NamedRoute): Promise<Response> {
  const read = readOf(req.method, route);
  if (!read) throw methodNotAllowed(req.method);
  const served =
    ctx.target.repo.kind === "group"
      ? await fromGroup(ctx, read.op, req, read.arg)
      : await fromMirror(ctx, read.op, req, read.arg);
  if (!served) throw notFound(route);
  return served;
}

/** Builds the docker handler for the `/v2` mount: routing, token endpoint, authentication challenge, authorization and error mapping. */
export function createDockerHandlerWith(deps: FormatDeps, opts: DockerOptions): FormatHandler {
  const hub = createHubAuth(fetch, () => opts.now?.() ?? new Date());
  async function dispatch(req: Request, rest: string): Promise<Response> {
    const route = parseRoute(rest);
    if (!route) {
      throw invalidReference(rest) ?? new DockerError(404, "UNSUPPORTED", "unknown route");
    }
    validate(route);
    const now = opts.now?.() ?? new Date();

    if (route.kind === "token") return handleToken(deps, req, now);
    if (route.kind === "base") {
      const caller = await identify(deps, req, { now });
      if (caller.principal.kind === "anonymous" && !caller.claims) throw challenge(deps.publicUrl);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "docker-distribution-api-version": "registry/2.0" },
      });
    }

    const action = actionOf(req.method, route);
    const scope = scopeFor(route.name, action);
    const caller = await identify(deps, req, { now, scope });
    const anonymous = caller.principal.kind === "anonymous";
    let target: Target | null;
    try {
      target = await resolveTarget(deps.repos, route.name);
    } catch (err) {
      if (anonymous) throw scopeChallenge(deps, caller, scope);
      throw err;
    }
    if (!target) {
      if (anonymous) throw scopeChallenge(deps, caller, scope);
      throw new DockerError(404, "NAME_UNKNOWN", "repository name not known to registry", { name: route.name });
    }
    requireAccess(deps, caller, target, action);
    if (target.repo.kind === "hosted") {
      const served = dispatchHosted({ deps, opts, caller, target }, req, route);
      if (served) return served;
      throw methodNotAllowed(req.method);
    }
    return dispatchReadOnly({ deps, caller, target, hub }, req, route);
  }

  return async (req, rest) => {
    try {
      return await dispatch(req, rest);
    } catch (err) {
      return toResponse(err, deps.publicUrl);
    }
  };
}

/** The docker handler with uploads staged in `WEAVER_DOCKER_UPLOAD_DIR` (default `<tmpdir>/weaver-uploads`). */
export const createDockerHandler: FormatFactory = (deps) =>
  createDockerHandlerWith(deps, { uploadDir: process.env.WEAVER_DOCKER_UPLOAD_DIR ?? join(tmpdir(), "weaver-uploads") });
