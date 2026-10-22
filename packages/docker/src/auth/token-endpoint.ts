import { randomUUID } from "node:crypto";
import { RegistryError, type FormatDeps, type Principal, type Repo, type RepoService } from "@weaver/core";
import { DockerError, errorResponse } from "../errors.js";
import { parseRoute } from "../route.js";
import { resolveTarget, type Target } from "../target.js";
import { permits, serviceHost } from "./authorize.js";
import { parseScopes, signToken, tokenKey, type AccessEntry, type DockerClaims } from "./jwt.js";

const TOKEN_TTL_SECONDS = 300;
/** The most distinct image names one token request may ask for. */
const MAX_SCOPE_NAMES = 32;
/** The largest POST form body read, in bytes. */
const MAX_FORM_BYTES = 64 * 1024;

/** A view of `repos` that looks up the docker root at most once. */
function withCachedRoot(repos: RepoService): Pick<RepoService, "get" | "dockerRoot"> {
  let root: Promise<Repo | null> | undefined;
  return { get: (name) => repos.get(name), dockerRoot: () => (root ??= repos.dockerRoot()) };
}

/** The target of a scope name, or null when the name is malformed, names only a repository, or is unknown. */
async function scopeTarget(repos: Pick<RepoService, "get" | "dockerRoot">, name: string): Promise<Target | null> {
  try {
    if (parseRoute(`${name}/tags/list`)?.kind !== "tags") return null;
    return await resolveTarget(repos, name);
  } catch (err) {
    if (err instanceof DockerError) return null;
    throw err;
  }
}

/**
 * Evaluates every requested entry: pull needs read (of the group, for a group), push and delete need
 * write and are never granted on mirror or group targets. Each entry is kept, with only the granted
 * actions (possibly none) and bound to the id of the repository its name resolved to.
 */
export async function grantAccess(deps: FormatDeps, p: Principal, requested: AccessEntry[]): Promise<AccessEntry[]> {
  const repos = withCachedRoot(deps.repos);
  const granted: AccessEntry[] = [];
  for (const entry of requested) {
    const target = await scopeTarget(repos, entry.name);
    if (!target) {
      granted.push({ type: "repository", name: entry.name, actions: [] });
      continue;
    }
    const actions = entry.actions.filter((a) => permits(p, target.repo, a));
    granted.push({ type: "repository", name: entry.name, actions, repo: target.repo.id });
  }
  return granted;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "docker-distribution-api-version": "registry/2.0" },
  });
}

/** Resolves the principal of a token request; bad credentials become `401 UNAUTHORIZED` with a Basic challenge. */
async function authenticate(deps: FormatDeps, req: Request): Promise<Principal> {
  try {
    return await deps.principal(req);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "unauthorized") {
      throw new DockerError(401, "UNAUTHORIZED", "incorrect username or password", undefined, {
        "www-authenticate": `Basic realm="${serviceHost(deps.publicUrl)}"`,
      });
    }
    throw err;
  }
}

/** Reads a request body as text, or null when it exceeds `limit` bytes (stopping the read there). */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The request to authenticate and the requested scopes of a GET query or a POST `grant_type=password` form, or the response to send instead. */
async function readRequest(req: Request): Promise<{ authReq: Request; scopes: string[] } | Response> {
  if (req.method === "GET") return { authReq: req, scopes: new URL(req.url).searchParams.getAll("scope") };
  if (req.method !== "POST") throw new DockerError(405, "UNSUPPORTED", "the token endpoint takes GET or POST");
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(400, { error: "invalid_request" });
  const body = await readCapped(req, MAX_FORM_BYTES);
  if (body === null) return json(413, { error: "invalid_request" });
  const form = new URLSearchParams(body);
  if (form.get("grant_type") !== "password") return json(400, { error: "unsupported_grant_type" });
  const credentials = Buffer.from(`${form.get("username") ?? ""}:${form.get("password") ?? ""}`).toString("base64");
  return {
    authReq: new Request(req.url, { headers: { authorization: `Basic ${credentials}` } }),
    scopes: form.getAll("scope"),
  };
}

/**
 * Serves `/v2/token`: `GET ?service=&scope=` authenticated through `deps.principal` (anonymous without
 * credentials), or `POST` form `grant_type=password` (containerd, body at most 64 KiB). Answers
 * `{token, access_token, expires_in: 300, issued_at}` with a JWT holding the evaluated access; more than
 * 32 distinct names → `400 invalid_scope`; bad credentials → `401 UNAUTHORIZED`.
 */
export async function handleToken(deps: FormatDeps, req: Request, now: Date = new Date()): Promise<Response> {
  try {
    const read = await readRequest(req);
    if (read instanceof Response) return read;
    const requested = parseScopes(read.scopes);
    if (requested.length > MAX_SCOPE_NAMES) return json(400, { error: "invalid_scope" });
    const p = await authenticate(deps, read.authReq);
    const iat = Math.floor(now.getTime() / 1000);
    const claims: DockerClaims = {
      iss: "weaver",
      aud: serviceHost(deps.publicUrl),
      sub: p.kind === "anonymous" ? "anonymous" : p.userId,
      iat,
      nbf: iat,
      exp: iat + TOKEN_TTL_SECONDS,
      jti: randomUUID(),
      access: await grantAccess(deps, p, requested),
      wv:
        p.kind === "anonymous"
          ? { kind: "anonymous" }
          : p.kind === "user"
            ? { kind: "user", userId: p.userId, role: p.role }
            : { kind: "apikey", userId: p.userId, keyId: p.keyId, role: p.role },
    };
    const token = signToken(tokenKey(deps.secretKey), claims);
    return json(200, {
      token,
      access_token: token,
      expires_in: TOKEN_TTL_SECONDS,
      issued_at: new Date(iat * 1000).toISOString(),
    });
  } catch (err) {
    if (err instanceof DockerError) return errorResponse(err);
    throw err;
  }
}
