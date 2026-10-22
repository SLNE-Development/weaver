import {
  createRegistry,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  packArchive,
  type Principal,
  type ProtoFile,
} from "@weaver/core";
import { repository, type Db } from "@weaver/db";
import { ARTIFACTS, AUTH_SECRET, MIRROR_UPSTREAM, USERS, serverEnv } from "./fixtures";

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";\n`).join("");
  return { path, content: `syntax = "proto3";\n\npackage ${pkg};\n\n${importLines}${body}\n` };
}

/**
 * Seeds the browse fixtures through the real publish path: a public `releases` and a private
 * `snapshots` repository, `dev.example:demo:1.0.0` (money.proto), `dev.example:orders:1.0.0`
 * depending on it (so deleting demo hits `has_dependents`), two builds of
 * `dev.example:demo:1.1.0-SNAPSHOT` and `dev.example:scratch:0.1.0`, which a test deletes. Also a
 * public proto mirror without caching and a public proto group of `releases` and that mirror.
 */
export async function seedArtifacts(db: Db): Promise<void> {
  const rows = await db.insert(repository).values([
    { name: ARTIFACTS.releases, format: "proto", kind: "hosted", description: "Released contracts", visibility: "public" },
    { name: ARTIFACTS.snapshots, format: "proto", kind: "hosted", description: "Snapshot builds", visibility: "private" },
  ]).returning({ id: repository.id, name: repository.name });

  const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: serverEnv().STORAGE_LOCAL_PATH });
  // Publishing reads repositories only; upstream secrets are never touched.
  const repos = createRepoService({ db, stores, secretKey: deriveSecretKey(AUTH_SECRET) });
  const registry = createRegistry({ db, stores, repos });
  // Publishing needs a key with write access (users can't publish from the UI); this one is never stored.
  const publisher: Principal = {
    kind: "apikey",
    keyId: "e2e-seed-key",
    userId: USERS.admin.id,
    role: "admin",
    permissions: rows.map((repo) => ({
      repositoryId: repo.id,
      repository: repo.name,
      groupPrefix: null,
      access: "write" as const,
    })),
  };
  const money = proto(
    "dev/example/money/v1/money.proto",
    "// An amount of money in minor units.\nmessage Money {\n  string currency = 1;\n  int64 cents = 2;\n}",
  );
  const currency = proto("dev/example/money/v1/currency.proto", 'enum Currency {\n  CURRENCY_UNSPECIFIED = 0;\n  EUR = 1;\n  USD = 2;\n}');
  const order = proto(
    "dev/example/orders/v1/order.proto",
    "message Order {\n  string id = 1;\n  dev.example.money.v1.Money total = 2;\n}",
    ["dev/example/money/v1/money.proto"],
  );

  const publish = async (repo: string, name: string, version: string, files: ProtoFile[], dependencies: string[] = []) =>
    registry.publish(publisher, {
      repository: repo,
      manifest: { group: "dev.example", name, version, dependencies },
      archive: await packArchive(files),
    });

  await publish(ARTIFACTS.releases, "demo", "1.0.0", [money, currency]);
  await publish(ARTIFACTS.releases, "orders", "1.0.0", [order], ["dev.example:demo:1.0.0"]);
  await publish(ARTIFACTS.snapshots, "demo", "1.1.0-SNAPSHOT", [money, currency]);
  await publish(ARTIFACTS.snapshots, "demo", "1.1.0-SNAPSHOT", [money]);
  // Deleted by browse.spec (its only version), so nothing else may rely on it.
  await publish(ARTIFACTS.releases, "scratch", "0.1.0", [proto("dev/example/scratch/v1/scratch.proto", "message Scratch {}")]);

  const asAdmin: Principal = { kind: "user", userId: USERS.admin.id, role: "admin" };
  await repos.create(asAdmin, {
    name: ARTIFACTS.mirror,
    format: "proto",
    kind: "mirror",
    visibility: "public",
    upstreams: [{ url: MIRROR_UPSTREAM, authType: "none" }],
  });
  await repos.create(asAdmin, {
    name: ARTIFACTS.group,
    format: "proto",
    kind: "group",
    visibility: "public",
    members: [ARTIFACTS.releases, ARTIFACTS.mirror],
  });
}
