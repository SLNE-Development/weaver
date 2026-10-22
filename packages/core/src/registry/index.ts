import type { Db } from "@weaver/db";
import type { Coordinate } from "../coordinates.js";
import type { Principal } from "../permissions.js";
import type { RepoService } from "../repos/service.js";
import type { StoreSet } from "../storage/index.js";
import { validateProtos } from "../validation.js";
import { deleteVersion } from "./delete.js";
import type { RegistryContext } from "./lookup.js";
import { publish, type PublishInput, type PublishResult } from "./publish.js";
import {
  createHostedReader,
  download,
  getFile,
  getManifest,
  listDependents,
  listVersions,
  type BuildSelector,
  type Dependent,
  type HostedReader,
  type VersionInfo,
  type VersionSummary,
} from "./read.js";

export { publishRepositoryOrder, type Queryable } from "./lookup.js";
export { manifestSchema, type Manifest, type PublishInput, type PublishResult } from "./publish.js";
export type { BuildSelector, Dependent, HostedArchive, HostedReader, VersionInfo, VersionSummary } from "./read.js";

/**
 * The hosted proto registry: publishing, reading and deleting artifact versions of hosted proto
 * repositories. Publishing to or deleting from a mirror or group is `method_not_allowed`.
 */
export interface Registry {
  /** Publishes an archive to a hosted proto repository, resolving its dependencies in local hosted repos. */
  publish(p: Principal, input: PublishInput): Promise<PublishResult>;
  /** The versions of an artifact, newest first; `not_found` when the repository or artifact is absent or unreadable. */
  listVersions(p: Principal, repository: string, group: string, name: string): Promise<VersionSummary[]>;
  /** Metadata of the newest build, or of build `select.buildNumber`. */
  getManifest(p: Principal, repository: string, c: Coordinate, select?: BuildSelector): Promise<VersionInfo>;
  /** The archive of the newest build, or of build `select.buildNumber` (`not_found` once it is gone). */
  download(
    p: Principal,
    repository: string,
    c: Coordinate,
    select?: BuildSelector,
  ): Promise<{ data: Buffer; sha256: string; filename: string }>;
  /** One proto file of a version's newest build. */
  getFile(p: Principal, repository: string, c: Coordinate, path: string): Promise<string>;
  /** Versions in any repository that depend on `c`; not filtered by principal. */
  listDependents(c: Coordinate): Promise<Dependent[]>;
  /** Deletes a version with its builds; blocked by dependents unless an admin forces it. */
  deleteVersion(p: Principal, repository: string, c: Coordinate, opts?: { force?: boolean }): Promise<void>;
  /** Unchecked reads of hosted proto repositories, for callers that authorise the read themselves. */
  hosted: HostedReader;
}

/**
 * Creates the registry over a database, the object stores (new archives go to `stores.primary`)
 * and the repository service; `validate` defaults to buf-backed {@link validateProtos}.
 */
export function createRegistry(deps: { db: Db; stores: StoreSet; repos: RepoService; validate?: typeof validateProtos }): Registry {
  const ctx: RegistryContext = { db: deps.db, stores: deps.stores, repos: deps.repos, validate: deps.validate ?? validateProtos };
  const hosted = createHostedReader(ctx);
  return {
    publish: (p, input) => publish(ctx, p, input),
    listVersions: (p, repository, group, name) => listVersions(ctx, hosted, p, repository, group, name),
    getManifest: (p, repository, c, select) => getManifest(ctx, hosted, p, repository, c, select),
    download: (p, repository, c, select) => download(ctx, hosted, p, repository, c, select),
    getFile: (p, repository, c, path) => getFile(ctx, p, repository, c, path),
    listDependents: (c) => listDependents(ctx.db, c),
    deleteVersion: (p, repository, c, opts) => deleteVersion(ctx, p, repository, c, opts),
    hosted,
  };
}
