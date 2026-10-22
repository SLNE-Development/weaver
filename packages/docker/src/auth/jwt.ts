import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { Role } from "@weaver/core";

/** An action a docker token can grant on a repository. */
export type DockerAction = "pull" | "push" | "delete";

/** One `access` entry of a docker token: the actions granted on an image name. */
export interface AccessEntry {
  type: "repository";
  /** The image name as the client sends it (e.g. `myrepo/app` or `library/nginx`). */
  name: string;
  actions: DockerAction[];
  /** The id of the repository the name resolved to at issuance; absent when it resolved to none. */
  repo?: string;
}

/** The claims of a Weaver docker bearer token. */
export interface DockerClaims {
  iss: "weaver";
  /** The registry host the token is for. */
  aud: string;
  /** The user id, or `"anonymous"`. */
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  /** One entry per requested name, holding only the actions actually granted at issuance (possibly none). */
  access: AccessEntry[];
  /** Who the token was issued to, for authorization and usage attribution. */
  wv: { kind: "anonymous" | "user" | "apikey"; userId?: string; keyId?: string; role?: Role };
}

const ACTIONS: readonly DockerAction[] = ["pull", "push", "delete"];
/** Clock skew tolerated on `nbf`; `exp` is enforced exactly. */
const NBF_LEEWAY_SECONDS = 30;
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

/** Derives the 32-byte HS256 key for docker tokens from the server key (HKDF-SHA256, info "weaver-docker-token"). */
export function tokenKey(secretKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(0), "weaver-docker-token", 32));
}

function mac(key: Buffer, input: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

/** Signs `claims` as a compact HS256 JWT. */
export function signToken(key: Buffer, claims: DockerClaims): string {
  const input = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${input}.${mac(key, input).toString("base64url")}`;
}

function parseJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Whether `token` has the shape of a compact JWT with an HS256 header (whatever its signature). */
export function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  const header = parseJson(parts[0]!) as { alg?: unknown } | null;
  return typeof header === "object" && header !== null && header.alg === "HS256";
}

function isClaims(v: unknown): v is DockerClaims {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    c.iss === "weaver" &&
    typeof c.aud === "string" &&
    typeof c.sub === "string" &&
    typeof c.exp === "number" &&
    typeof c.nbf === "number" &&
    typeof c.iat === "number" &&
    Array.isArray(c.access) &&
    typeof c.wv === "object" &&
    c.wv !== null
  );
}

/**
 * Verifies a token signed by {@link signToken}: returns its claims, or null when the signature is bad,
 * the header is not HS256, the audience differs, it expired (no leeway) or is not yet valid (30 s leeway).
 */
export function verifyToken(key: Buffer, token: string, aud: string, now: Date): DockerClaims | null {
  if (!looksLikeJwt(token)) return null;
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const expected = mac(key, `${header}.${payload}`);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = parseJson(payload);
  if (!isClaims(claims) || claims.aud !== aud) return null;
  const t = Math.floor(now.getTime() / 1000);
  if (t > claims.exp || t < claims.nbf - NBF_LEEWAY_SECONDS) return null;
  return claims;
}

/**
 * Parses scope strings (`repository:a/b:pull,push`, each value possibly a space-separated list) into
 * access entries, merging actions per name; `*` means every action, unknown types and actions are ignored.
 */
export function parseScopes(values: string[]): AccessEntry[] {
  const byName = new Map<string, Set<DockerAction>>();
  for (const scope of values.flatMap((v) => v.split(/\s+/)).filter(Boolean)) {
    const first = scope.indexOf(":");
    const last = scope.lastIndexOf(":");
    if (first < 0 || last === first || scope.slice(0, first) !== "repository") continue;
    const name = scope.slice(first + 1, last);
    const actions = scope
      .slice(last + 1)
      .split(",")
      .flatMap((a): DockerAction[] => (a === "*" ? [...ACTIONS] : ACTIONS.includes(a as DockerAction) ? [a as DockerAction] : []));
    if (!name || actions.length === 0) continue;
    const set = byName.get(name) ?? new Set<DockerAction>();
    for (const a of actions) set.add(a);
    byName.set(name, set);
  }
  return [...byName].map(([name, set]) => ({
    type: "repository",
    name,
    actions: ACTIONS.filter((a) => set.has(a)),
  }));
}
