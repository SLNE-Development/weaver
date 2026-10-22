import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";

/** Builds a gzipped npm tarball holding `package/package.json` with the name, version and `extra` fields. */
export async function makeTarball(name: string, version: string, extra: Record<string, unknown> = {}): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-npm-fixture-"));
  try {
    await mkdir(join(dir, "package"));
    await writeFile(join(dir, "package", "package.json"), JSON.stringify({ name, version, ...extra }, null, 2));
    const chunks: Buffer[] = [];
    const stream = create({ gzip: true, cwd: dir, portable: true, mtime: new Date(0) }, ["package"]);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The `sha1` hex and `sha512-<base64>` integrity of a tarball, as npm computes them. */
export function digestsOf(tarball: Buffer): { shasum: string; integrity: string } {
  return {
    shasum: createHash("sha1").update(tarball).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  };
}

/** Builds the JSON body `npm publish` sends: one version, its dist digests and the tarball as a base64 attachment. */
export function publishBody(name: string, version: string, tarball: Buffer, opts: { tag?: string; readme?: string } = {}): unknown {
  const file = `${name}-${version}.tgz`;
  const { shasum, integrity } = digestsOf(tarball);
  return {
    _id: name,
    name,
    description: `the ${name} package`,
    "dist-tags": { [opts.tag ?? "latest"]: version },
    versions: {
      [version]: {
        name,
        version,
        description: `the ${name} package`,
        keywords: ["fixture"],
        _id: `${name}@${version}`,
        dist: { shasum, integrity, tarball: `http://localhost:4873/${name}/-/${file}` },
      },
    },
    access: null,
    ...(opts.readme === undefined ? {} : { readme: opts.readme }),
    _attachments: {
      [file]: { content_type: "application/octet-stream", data: tarball.toString("base64"), length: tarball.length },
    },
  };
}
