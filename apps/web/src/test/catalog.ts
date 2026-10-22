/** Test-only helpers: insert catalog rows directly into a test database. */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  protoArtifact as artifact,
  protoBuild as build,
  protoBuildFile as buildFile,
  protoDependency as dependency,
  protoVersion as version,
  repoPermission,
  repository,
  type Db,
} from "@weaver/db";

/** Test helper: inserts a hosted proto repository row and returns its id. */
export async function insertRepository(db: Db, name: string, visibility: "public" | "private"): Promise<string> {
  const [row] = await db
    .insert(repository)
    .values({ name, visibility, format: "proto", kind: "hosted" })
    .returning({ id: repository.id });
  return row!.id;
}

/** Test helper: grants an API key the given scopes, naming existing repositories by name. */
export async function insertKeyPermissions(
  db: Db,
  apiKeyId: string,
  permissions: { repository: string; groupPrefix?: string | null; access: "read" | "write" }[],
): Promise<void> {
  const names = [...new Set(permissions.map((p) => p.repository))];
  const rows = await db
    .select({ id: repository.id, name: repository.name })
    .from(repository)
    .where(inArray(repository.name, names));
  const idOf = new Map(rows.map((r) => [r.name, r.id]));
  await db.insert(repoPermission).values(
    permissions.map((p) => {
      const repositoryId = idOf.get(p.repository);
      if (!repositoryId) throw new Error(`test repository ${p.repository} does not exist`);
      return { apiKeyId, repositoryId, groupPrefix: p.groupPrefix ?? null, access: p.access };
    }),
  );
}

/**
 * Test helper: inserts one artifact version with a single build directly into the tables the
 * registry reads (no archive blob, so only metadata reads work).
 */
export async function insertVersion(
  db: Db,
  repositoryId: string,
  c: { group: string; name: string; version: string },
  opts: { files?: string[]; dependencies?: { group: string; name: string; version: string }[] } = {},
): Promise<void> {
  const [art] = await db
    .insert(artifact)
    .values({ repositoryId, group: c.group, name: c.name })
    .onConflictDoUpdate({ target: [artifact.repositoryId, artifact.group, artifact.name], set: { group: c.group } })
    .returning({ id: artifact.id });
  const [ver] = await db
    .insert(version)
    .values({ artifactId: art!.id, version: c.version, isSnapshot: c.version.endsWith("-SNAPSHOT") })
    .returning({ id: version.id });
  const [b] = await db
    .insert(build)
    .values({ versionId: ver!.id, buildNumber: 1, store: "local", storageKey: `test/${randomUUID()}`, sha256: "0".repeat(64), sizeBytes: 1 })
    .returning({ id: build.id });
  const files = opts.files ?? [`${c.group.replaceAll(".", "/")}/${c.name}.proto`];
  if (files.length > 0) {
    await db.insert(buildFile).values(files.map((path) => ({ buildId: b!.id, path, content: 'syntax = "proto3";\n' })));
  }
  const deps = opts.dependencies ?? [];
  if (deps.length > 0) {
    await db
      .insert(dependency)
      .values(deps.map((d) => ({ buildId: b!.id, depGroup: d.group, depName: d.name, depVersion: d.version })));
  }
}
