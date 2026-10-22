import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { asset, groupMember, protoArtifact, protoBuild, protoVersion, repository, repositoryUpstream, type Db, type Tx } from "@weaver/db";
import { recordAudit } from "../audit.js";
import { isValidRepositoryName } from "../coordinates.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { RegistryError } from "../errors.js";
import { isAdmin, type Principal } from "../permissions.js";
import type { StoreId, StoreSet } from "../storage/index.js";
import {
  FORMATS,
  KINDS,
  parseRepositoryConfig,
  readRepositoryConfig,
  type Format,
  type Kind,
  type MirrorConfig,
  type RepositoryConfig,
} from "./config.js";

/** A repository with its parsed config. */
export interface Repo {
  id: string;
  name: string;
  format: Format;
  kind: Kind;
  description: string | null;
  visibility: "public" | "private";
  /** Docker only: served for image names without a repository prefix. */
  dockerRoot: boolean;
  config: RepositoryConfig;
}

/** How a mirror authenticates against an upstream. */
export type UpstreamAuthType = "none" | "basic" | "bearer";

/** One upstream of a mirror as an admin sends it. */
export interface UpstreamInput {
  url: string;
  authType: UpstreamAuthType;
  username?: string | null;
  /** undefined = keep existing secret */
  secret?: string | null;
}

/** One upstream of a mirror as clients see it: whether a secret is stored, never the secret. */
export interface UpstreamView {
  id: string;
  url: string;
  authType: UpstreamAuthType;
  username: string | null;
  hasSecret: boolean;
}

/** What creating a repository takes; everything but name, format and kind has defaults. */
export interface CreateRepoInput {
  name: string;
  format: Format;
  kind: Kind;
  description?: string | null;
  visibility?: "public" | "private";
  /** Validated and completed with {@link parseRepositoryConfig}. */
  config?: unknown;
  /** Mirrors only, at least one, tried in this order. */
  upstreams?: UpstreamInput[];
  /** Groups only: repo names, ordered */
  members?: string[];
  /** Docker only; at most one repository is the docker root. */
  dockerRoot?: boolean;
}

/** What updating a repository takes; omitted fields are kept, `config` is deep-merged into the current config. */
export type UpdateRepoInput = Partial<Omit<CreateRepoInput, "name" | "format" | "kind">>;

/** Options of {@link RepoService.delete}. */
export interface DeleteRepoOptions {
  /**
   * A read-only check, run with the repository row locked before anything is deleted; throw to
   * refuse the delete. It must not write: its queries share the delete's transaction.
   */
  guard?: (tx: Tx, repo: Repo) => Promise<void>;
}

/** Repository management: reading repositories and, for admins, creating, changing and deleting them. Every mutation is audited. */
export interface RepoService {
  /** Every repository, by name. */
  list(): Promise<Repo[]>;
  /** The repository named `name`, or null. */
  get(name: string): Promise<Repo | null>;
  /** The repository with id `id`, or null. */
  getById(id: string): Promise<Repo | null>;
  /** Creates a repository; `forbidden` for non-admins, `invalid_request` for invalid or conflicting input. */
  create(actor: Principal, input: CreateRepoInput): Promise<Repo>;
  /** Changes a repository; `not_found` when it does not exist. */
  update(actor: Principal, name: string, patch: UpdateRepoInput): Promise<Repo>;
  /**
   * Deletes a repository with all its content: first the rows (content, upstreams, memberships and
   * key permissions cascade) in one transaction, then, after commit, the stored objects of its
   * assets and proto builds. Objects that cannot be deleted are left orphaned and logged.
   * `opts.guard` runs inside that transaction with the row locked (no content can be added
   * meanwhile) and refuses the delete by throwing.
   */
  delete(actor: Principal, name: string, opts?: DeleteRepoOptions): Promise<void>;
  /** The upstreams of a mirror in order, without secrets. */
  upstreams(repoId: string): Promise<UpstreamView[]>;
  /** The upstreams of a mirror in order with decrypted secrets; for server-side use only. */
  upstreamsWithSecrets(repoId: string): Promise<Array<UpstreamView & { secret: string | null }>>;
  /** The members of a group in order. */
  members(groupId: string): Promise<Repo[]>;
  /** The groups a repository is a member of, by name. */
  groupsContaining(memberId: string): Promise<Repo[]>;
  /** The docker root repository, or null. */
  dockerRoot(): Promise<Repo | null>;
}

type RepositoryRow = typeof repository.$inferSelect;
type UpstreamRow = typeof repositoryUpstream.$inferSelect;

/** Docker resolves `library/<image>` on Docker Hub, so no docker repository may take that name. */
const RESERVED_DOCKER_NAME = "library";
const DESCRIPTION_MAX = 500;
const URL_MAX = 2000;

function invalid(message: string, details?: unknown): RegistryError {
  return new RegistryError("invalid_request", message, details);
}

/** A `repository` row as a {@link Repo}, its config read leniently with {@link readRepositoryConfig}. */
export function toRepo(row: RepositoryRow): Repo {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    kind: row.kind,
    description: row.description,
    visibility: row.visibility,
    dockerRoot: row.dockerRoot,
    config: readRepositoryConfig(row),
  };
}

function toView(row: UpstreamRow): UpstreamView {
  return { id: row.id, url: row.url, authType: row.authType, username: row.username, hasSecret: row.secret !== null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merges `patch` into `base`: nested plain objects merge key by key, everything else is replaced. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = deepMerge(base[key], value);
  }
  return out;
}

/** The constraint name of a unique violation in `error` or its causes, or null. */
function uniqueViolation(error: unknown): string | null {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pg = e as { code?: unknown; constraint?: unknown };
    if (pg.code === "23505") return typeof pg.constraint === "string" ? pg.constraint : "";
  }
  return null;
}

function nameTaken(name: string): RegistryError {
  return invalid(`Repository ${name} already exists`, { field: "name", reason: "taken" });
}

function dockerRootTaken(): RegistryError {
  return invalid("Another docker repository is already the docker root", { field: "dockerRoot", reason: "taken" });
}

function checkDescription(description: string | null | undefined): string | null | undefined {
  if (description === undefined || description === null) return description;
  const trimmed = description.trim();
  if (trimmed.length > DESCRIPTION_MAX) throw invalid(`Description must be at most ${DESCRIPTION_MAX} characters`);
  return trimmed === "" ? null : trimmed;
}

function checkVisibility(visibility: unknown): void {
  if (visibility !== undefined && visibility !== "public" && visibility !== "private") {
    throw invalid(`Invalid visibility ${String(visibility)}`);
  }
}

/** The normalized upstream URL; rejects anything but absolute http(s) URLs without embedded credentials. */
function checkUpstreamUrl(raw: unknown): string {
  const url = typeof raw === "string" ? raw.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid(`Invalid upstream URL ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid(`Upstream URL ${url} must use http or https`);
  if (parsed.username || parsed.password) throw invalid(`Upstream URL ${url} must not contain credentials; use the upstream's auth settings`);
  if (url.length > URL_MAX) throw invalid(`Upstream URL must be at most ${URL_MAX} characters`);
  return url;
}

/** Upstreams without secrets, for audit details. */
function upstreamSummary(upstreams: UpstreamInput[] | undefined) {
  return upstreams?.map((u) => ({ url: u.url, authType: u.authType, username: u.username ?? null }));
}

/** An input or patch with secrets removed, for audit details. */
function auditDetails(input: UpdateRepoInput & Partial<Pick<CreateRepoInput, "format" | "kind">>): Record<string, unknown> {
  const { upstreams, ...rest } = input;
  return upstreams === undefined ? rest : { ...rest, upstreams: upstreamSummary(upstreams) };
}

/** Creates the repository service over the database, the object stores and the upstream-credential key. */
export function createRepoService(deps: { db: Db; stores: StoreSet; secretKey: Buffer }): RepoService {
  const { db, stores, secretKey } = deps;

  function requireAdmin(actor: Principal): void {
    if (!isAdmin(actor)) throw new RegistryError("forbidden", "Only admins can manage repositories");
  }

  /**
   * Replaces the upstreams of a mirror. An omitted secret keeps the stored one only for an upstream
   * with the same URL, auth type and (for basic auth) username; otherwise it is dropped.
   */
  async function writeUpstreams(tx: Tx, repoId: string, inputs: UpstreamInput[], existing: UpstreamRow[]): Promise<void> {
    if (!Array.isArray(inputs) || inputs.length === 0) throw invalid("A mirror needs at least one upstream");
    const unused = [...existing];
    const rows = inputs.map((input, position) => {
      if (!isPlainObject(input)) throw invalid("Invalid upstream");
      const url = checkUpstreamUrl(input.url);
      const authType = input.authType;
      if (authType !== "none" && authType !== "basic" && authType !== "bearer") {
        throw invalid(`Invalid upstream auth type ${String(authType)}`);
      }
      const index = unused.findIndex((row) => row.url === url);
      const previous = index >= 0 ? unused.splice(index, 1)[0]! : null;
      if (authType === "none") return { repositoryId: repoId, position, url, authType, username: null, secret: null };

      const username = typeof input.username === "string" && input.username.trim() !== "" ? input.username.trim() : null;
      if (authType === "basic" && username === null) throw invalid(`Upstream ${url} uses basic auth and needs a username`);
      const sameCredentials =
        previous !== null && previous.authType === authType && (authType !== "basic" || previous.username === username);
      let secret: string | null;
      if (input.secret === undefined) secret = sameCredentials ? previous.secret : null;
      else if (input.secret === null || input.secret === "") secret = null;
      else if (typeof input.secret === "string") secret = encryptSecret(secretKey, input.secret);
      else throw invalid(`Invalid secret for upstream ${url}`);
      if (authType === "bearer" && secret === null) throw invalid(`Upstream ${url} uses bearer auth and needs a token`);
      return { repositoryId: repoId, position, url, authType, username: authType === "basic" ? username : null, secret };
    });
    await tx.delete(repositoryUpstream).where(eq(repositoryUpstream.repositoryId, repoId));
    await tx.insert(repositoryUpstream).values(rows);
  }

  /** Replaces the members of a group; members must be existing hosted or mirror repos of the same format. */
  async function writeMembers(tx: Tx, group: RepositoryRow, names: string[]): Promise<void> {
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw invalid("Members must be repository names");
    if (new Set(names).size !== names.length) throw invalid("A repository can be a member of a group only once");
    const rows = names.length === 0 ? [] : await tx.select().from(repository).where(inArray(repository.name, names));
    const byName = new Map(rows.map((r) => [r.name, r]));
    const members = names.map((name) => {
      const member = byName.get(name);
      if (!member) throw invalid(`Member repository ${name} does not exist`, { field: "members", member: name });
      if (member.id === group.id) throw invalid("A group cannot contain itself");
      if (member.format !== group.format) {
        throw invalid(`Member ${name} is a ${member.format} repository, not ${group.format}`, { field: "members", member: name });
      }
      if (member.kind === "group") throw invalid(`Member ${name} is a group; groups cannot be nested`, { field: "members", member: name });
      return member;
    });
    await tx.delete(groupMember).where(eq(groupMember.groupId, group.id));
    if (members.length > 0) {
      await tx.insert(groupMember).values(members.map((m, position) => ({ groupId: group.id, memberId: m.id, position })));
    }
  }

  /**
   * Rejects making a repository the docker root unless it is a docker mirror and no other
   * repository (`id` excluded, null for a new one) is the root.
   */
  async function checkDockerRoot(
    tx: Tx,
    row: { id: string | null; format: Format; kind: Kind },
    dockerRoot: boolean | undefined,
  ): Promise<void> {
    if (!dockerRoot) return;
    if (row.format !== "docker" || row.kind !== "mirror") throw invalid("Only a docker mirror can be the docker root");
    const [other] = await tx
      .select({ id: repository.id })
      .from(repository)
      .where(and(eq(repository.dockerRoot, true), row.id === null ? undefined : ne(repository.id, row.id)));
    if (other) throw dockerRootTaken();
  }

  /** Rejects a mirror cache store that is not configured on this server. */
  function checkCacheStore(kind: Kind, config: RepositoryConfig): void {
    if (kind !== "mirror") return;
    const store = (config as MirrorConfig).cache.store;
    if (store !== null && !stores.configured().includes(store)) {
      throw invalid(`Cache store ${store} is not configured`, { field: "config.cache.store" });
    }
  }

  /** Runs `change` and maps unique violations of the name and docker-root constraints to `invalid_request`. */
  async function guarded<T>(name: string, change: () => Promise<T>): Promise<T> {
    try {
      return await change();
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === "repository_docker_root_uq") throw dockerRootTaken();
      if (constraint !== null && constraint.startsWith("repository_name")) throw nameTaken(name);
      throw error;
    }
  }

  async function findRow(q: Db | Tx, name: string, forUpdate = false): Promise<RepositoryRow | null> {
    const query = q.select().from(repository).where(eq(repository.name, name));
    const [row] = await (forUpdate ? query.for("update") : query);
    return row ?? null;
  }

  return {
    async list() {
      return (await db.select().from(repository).orderBy(asc(repository.name))).map(toRepo);
    },

    async get(name) {
      const row = await findRow(db, name);
      return row ? toRepo(row) : null;
    },

    async getById(id) {
      const [row] = await db.select().from(repository).where(eq(repository.id, id));
      return row ? toRepo(row) : null;
    },

    async create(actor, input) {
      requireAdmin(actor);
      const { name, format, kind } = input;
      if (typeof name !== "string" || !isValidRepositoryName(name)) throw invalid(`Invalid repository name ${JSON.stringify(name)}`);
      if (!FORMATS.includes(format)) throw invalid(`Invalid format ${String(format)}`);
      if (!KINDS.includes(kind)) throw invalid(`Invalid kind ${String(kind)}`);
      if (format === "docker" && name === RESERVED_DOCKER_NAME) throw invalid(`The name ${RESERVED_DOCKER_NAME} is reserved for docker`);
      if (kind !== "mirror" && input.upstreams !== undefined) throw invalid("Only mirrors have upstreams");
      if (kind === "mirror" && input.upstreams === undefined) throw invalid("A mirror needs at least one upstream");
      if (kind !== "group" && input.members !== undefined) throw invalid("Only groups have members");
      checkVisibility(input.visibility);
      const description = checkDescription(input.description) ?? null;
      const config = parseRepositoryConfig(format, kind, input.config);
      checkCacheStore(kind, config);

      const row = await guarded(name, () =>
        db.transaction(async (tx) => {
          if (await findRow(tx, name)) throw nameTaken(name);
          await checkDockerRoot(tx, { id: null, format, kind }, input.dockerRoot);
          const [created] = await tx
            .insert(repository)
            .values({
              name,
              format,
              kind,
              description,
              visibility: input.visibility ?? "private",
              config: config as Record<string, unknown>,
              dockerRoot: input.dockerRoot ?? false,
            })
            .returning();
          if (kind === "mirror") await writeUpstreams(tx, created!.id, input.upstreams!, []);
          if (kind === "group") await writeMembers(tx, created!, input.members ?? []);
          await recordAudit(tx, {
            actor,
            action: "repository.create",
            target: name,
            details: auditDetails({ ...input, config }),
          });
          return created!;
        }),
      );
      return toRepo(row);
    },

    async update(actor, name, patch) {
      requireAdmin(actor);
      checkVisibility(patch.visibility);
      const description = checkDescription(patch.description);
      // Guarded: two concurrent updates can both pass checkDockerRoot; the unique index decides.
      const row = await guarded(name, () => db.transaction(async (tx) => {
        const current = await findRow(tx, name, true);
        if (!current) throw new RegistryError("not_found", `Repository ${name} was not found`);
        if (current.kind !== "mirror" && patch.upstreams !== undefined) throw invalid("Only mirrors have upstreams");
        if (current.kind !== "group" && patch.members !== undefined) throw invalid("Only groups have members");
        const config =
          patch.config === undefined
            ? undefined
            : parseRepositoryConfig(current.format, current.kind, deepMerge(readRepositoryConfig(current), patch.config));
        if (config !== undefined) checkCacheStore(current.kind, config);
        await checkDockerRoot(tx, current, patch.dockerRoot);

        const values: Partial<typeof repository.$inferInsert> = {};
        if (description !== undefined) values.description = description;
        if (patch.visibility !== undefined) values.visibility = patch.visibility;
        if (config !== undefined) values.config = config as Record<string, unknown>;
        if (patch.dockerRoot !== undefined) values.dockerRoot = patch.dockerRoot;
        let updated = current;
        if (Object.keys(values).length > 0) {
          updated = (await tx.update(repository).set(values).where(eq(repository.id, current.id)).returning())[0]!;
        }
        if (patch.upstreams !== undefined) {
          const existing = await tx.select().from(repositoryUpstream).where(eq(repositoryUpstream.repositoryId, current.id));
          await writeUpstreams(tx, current.id, patch.upstreams, existing);
        }
        if (patch.members !== undefined) await writeMembers(tx, current, patch.members);
        await recordAudit(tx, { actor, action: "repository.update", target: name, details: auditDetails(patch) });
        return updated;
      }));
      return toRepo(row);
    },

    async delete(actor, name, opts) {
      requireAdmin(actor);
      const blobs = await db.transaction(async (tx) => {
        const current = await findRow(tx, name, true);
        if (!current) throw new RegistryError("not_found", `Repository ${name} was not found`);
        if (opts?.guard) await opts.guard(tx, toRepo(current));
        const assets = await tx
          .select({ store: asset.store, storageKey: asset.storageKey })
          .from(asset)
          .where(eq(asset.repositoryId, current.id));
        const builds = await tx
          .select({ store: protoBuild.store, storageKey: protoBuild.storageKey })
          .from(protoBuild)
          .innerJoin(protoVersion, eq(protoVersion.id, protoBuild.versionId))
          .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
          .where(eq(protoArtifact.repositoryId, current.id));
        // Content, upstreams, group memberships (both ways) and key permissions cascade with the row.
        await tx.delete(repository).where(eq(repository.id, current.id));
        await recordAudit(tx, {
          actor,
          action: "repository.delete",
          target: name,
          details: { format: current.format, kind: current.kind, assets: assets.length, builds: builds.length },
        });
        return [...assets, ...builds];
      });
      await deleteObjects(stores, blobs);
    },

    async upstreams(repoId) {
      return (await upstreamRows(db, repoId)).map(toView);
    },

    async upstreamsWithSecrets(repoId) {
      return (await upstreamRows(db, repoId)).map((row) => ({
        ...toView(row),
        secret: row.secret === null ? null : decryptSecret(secretKey, row.secret),
      }));
    },

    async members(groupId) {
      const rows = await db
        .select({ repo: repository })
        .from(groupMember)
        .innerJoin(repository, eq(repository.id, groupMember.memberId))
        .where(eq(groupMember.groupId, groupId))
        .orderBy(asc(groupMember.position));
      return rows.map((r) => toRepo(r.repo));
    },

    async groupsContaining(memberId) {
      const rows = await db
        .select({ repo: repository })
        .from(groupMember)
        .innerJoin(repository, eq(repository.id, groupMember.groupId))
        .where(eq(groupMember.memberId, memberId))
        .orderBy(asc(repository.name));
      return rows.map((r) => toRepo(r.repo));
    },

    async dockerRoot() {
      const [row] = await db.select().from(repository).where(eq(repository.dockerRoot, true));
      return row ? toRepo(row) : null;
    },
  };
}

function upstreamRows(db: Db, repoId: string): Promise<UpstreamRow[]> {
  return db
    .select()
    .from(repositoryUpstream)
    .where(eq(repositoryUpstream.repositoryId, repoId))
    .orderBy(asc(repositoryUpstream.position));
}

/**
 * Deletes the objects of a deleted repository, grouped by store. The rows are already gone, so a
 * failure or an unconfigured store only leaves orphaned objects behind and is logged.
 */
async function deleteObjects(stores: StoreSet, blobs: Array<{ store: StoreId; storageKey: string }>): Promise<void> {
  const byStore = new Map<StoreId, string[]>();
  for (const blob of blobs) byStore.set(blob.store, [...(byStore.get(blob.store) ?? []), blob.storageKey]);
  for (const [id, keys] of byStore) {
    const store = stores.get(id);
    if (!store) {
      console.warn(`weaver: cannot delete ${keys.length} objects of a deleted repository: store ${id} is not configured`);
      continue;
    }
    try {
      await store.deleteMany(keys);
    } catch (error) {
      console.warn(`weaver: failed to delete ${keys.length} objects of a deleted repository`, error);
    }
  }
}
