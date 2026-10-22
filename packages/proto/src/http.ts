import {
  isValidGroup,
  isValidName,
  isValidRepositoryName,
  isValidVersion,
  RegistryError,
  type Coordinate,
} from "@weaver/core";

/** Body of every `/api/v1` error response. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** A JSON response with the given status and extra headers. */
export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

/** The `/api/v1` error response for a registry error: its status, code, message and details. */
export function errorResponse(error: RegistryError, headers?: Record<string, string>): Response {
  const body: ErrorBody = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return json(body, error.status, headers);
}

/** Shorthand for an `invalid_request` error. */
export function invalidRequest(message: string, details?: unknown): RegistryError {
  return new RegistryError("invalid_request", message, details);
}

/** Whether the request carries `?force=true`. */
export function forceParam(req: Request): boolean {
  return new URL(req.url).searchParams.get("force") === "true";
}

/**
 * The build number in `?build=<n>`, or undefined without one; throws `invalid_request` unless it
 * is a positive integer.
 */
export function buildParam(req: Request): number | undefined {
  const raw = new URL(req.url).searchParams.get("build");
  if (raw === null) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw invalidRequest(`Invalid build number "${raw}"`);
  return Number(raw);
}

/** Path parameters of the artifact routes. */
export interface ArtifactParams {
  repo: string;
  group: string;
  name: string;
}

/** Path parameters of the version routes. */
export interface VersionParams extends ArtifactParams {
  version: string;
}

/** Checks the repository, group and name path segments; throws `invalid_request` when malformed. */
export function checkArtifactParams(params: ArtifactParams): void {
  if (!isValidRepositoryName(params.repo)) throw invalidRequest(`Invalid repository name "${params.repo}"`);
  if (!isValidGroup(params.group)) throw invalidRequest(`Invalid group "${params.group}"`);
  if (!isValidName(params.name)) throw invalidRequest(`Invalid artifact name "${params.name}"`);
}

/** The coordinate addressed by a version route; throws `invalid_request` when a segment is malformed. */
export function versionCoordinate(params: VersionParams): Coordinate {
  checkArtifactParams(params);
  if (!isValidVersion(params.version)) throw invalidRequest(`Invalid version "${params.version}"`);
  return { group: params.group, name: params.name, version: params.version };
}

/**
 * The absolute URL of one build's archive in `repository`, below the public base URL `publicUrl`
 * (never the request host). Pinning the build keeps a snapshot download consistent with the
 * resolve answer (build number, sha256) even when a newer build is published in between.
 */
export function archiveUrl(publicUrl: string, repository: string, c: Coordinate, buildNumber: number): string {
  const base = publicUrl.replace(/\/+$/, "");
  const segments = [repository, "artifacts", c.group, c.name, c.version].map(encodeURIComponent).join("/");
  return `${base}/api/v1/repos/${segments}/archive?build=${buildNumber}`;
}

/**
 * Reads the request body, refusing with `payload_too_large` as soon as it exceeds `maxBytes`,
 * whether or not the client sent a `Content-Length`.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new RegistryError("payload_too_large", `Request body exceeds ${maxBytes} bytes`);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Parses a JSON request body of at most `maxBytes`; throws `invalid_request` when it is not JSON. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBodyLimited(req, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidRequest("Request body must be valid JSON");
  }
}
