import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractArchive, sha256, type ProtoFile } from "@weaver/core/archive";
import { RegistryClient, type ResolveConflict } from "./client.js";
import { CliError } from "./config.js";

export interface FetchOptions {
  url: string;
  token?: string;
  repositories: string[];
  dependencies: string[];
  outDir: string;
  cacheDir: string;
  /** Directory relative paths and safety checks are based on; defaults to the process cwd. */
  cwd?: string;
  /** Config file in use; the output directory may not contain it. */
  configPath?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Replaces fs `rename` for the final directory swap (failure injection in tests). */
  renameFn?: typeof rename;
  /** Receives non-fatal notices such as version conflicts. */
  warn?: (message: string) => void;
}

export interface FetchResult {
  artifacts: number;
  files: number;
}

/** `node_modules/.cache/weaver` when a node_modules folder exists in `cwd`, else `~/.cache/weaver`. */
export function defaultCacheDir(cwd: string): string {
  return existsSync(join(cwd, "node_modules"))
    ? join(cwd, "node_modules", ".cache", "weaver")
    : join(homedir(), ".cache", "weaver");
}

const hasIllegalChar = (segment: string): boolean =>
  /[<>:"|?*]/.test(segment) || [...segment].some((ch) => ch.charCodeAt(0) < 0x20);
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Returns why a relative path cannot be created on Windows, or undefined when it is safe everywhere. */
function unsafeReason(path: string): string | undefined {
  for (const segment of path.split("/")) {
    if (hasIllegalChar(segment)) return `illegal character in "${segment}"`;
    // Windows treats "con.proto" like "con".
    if (RESERVED_NAMES.test(segment.split(".")[0] as string)) return `reserved name "${segment}"`;
    if (/[. ]$/.test(segment)) return `trailing dot or space in "${segment}"`;
  }
  return undefined;
}

interface Placed {
  coordinate: string;
  file: ProtoFile;
}

/** Validates every output path and flattens the artifacts into one conflict-free list. */
function placeFiles(extracted: { coordinate: string; files: ProtoFile[] }[]): Placed[] {
  const byKey = new Map<string, { path: string; coordinate: string }>();
  const placed: Placed[] = [];
  for (const { coordinate, files } of extracted) {
    for (const file of files) {
      const reason = unsafeReason(file.path);
      if (reason) {
        throw new CliError(`Unsafe output path "${file.path}" in ${coordinate}: ${reason}`);
      }
      const key = file.path.toLowerCase();
      const other = byKey.get(key);
      if (other) {
        throw new CliError(
          other.path === file.path
            ? `Path "${file.path}" is provided by both ${other.coordinate} and ${coordinate}`
            : `Paths "${other.path}" (${other.coordinate}) and "${file.path}" (${coordinate}) collide on case-insensitive file systems`,
        );
      }
      byKey.set(key, { path: file.path, coordinate });
      placed.push({ coordinate, file });
    }
  }
  return placed;
}

async function readCached(path: string, expected: string): Promise<Buffer | undefined> {
  try {
    const data = await readFile(path);
    return sha256(data) === expected ? data : undefined;
  } catch {
    return undefined;
  }
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Name of the file that marks a directory as created (and replaceable) by weaver. */
export const OUTPUT_MARKER = ".weaver-output";

/** Resolves symlinks of the deepest existing ancestor and re-appends the not-yet-existing rest. */
async function realResolve(path: string): Promise<string> {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      rest.push(basename(current));
      current = parent;
    }
  }
}

const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/** True when `child` is `parent` or lies inside it. */
function contains(parent: string, child: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Guards the directory that is about to be deleted and replaced: it must not be
 * (or contain) the working directory, config file, cache or node_modules, and an
 * existing non-empty directory must carry weaver's marker file.
 */
async function assertSafeOutDir(outDir: string, opts: FetchOptions, cwd: string): Promise<void> {
  const real = await realResolve(outDir);
  if (dirname(real) === real) throw new CliError("Refusing to replace the file system root");
  const protectedPaths: [string, string][] = [
    ["the working directory", cwd],
    ["the cache directory", opts.cacheDir],
    ["node_modules", join(cwd, "node_modules")],
  ];
  if (opts.configPath) protectedPaths.push(["the config file", opts.configPath]);
  for (const [label, path] of protectedPaths) {
    if (contains(real, await realResolve(path))) {
      throw new CliError(`Refusing to replace ${outDir}: it is or contains ${label}`);
    }
  }
  let entries: string[];
  try {
    entries = await readdir(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new CliError(`${outDir} exists and is not a directory`);
  }
  if (entries.length > 0 && !entries.includes(OUTPUT_MARKER)) {
    throw new CliError(
      `${outDir} exists and wasn't created by weaver; remove it or choose another outDir`,
    );
  }
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Moves `tmpDir` into place; the previous `outDir` is renamed aside first and restored if the swap fails. */
async function swapIn(tmpDir: string, outDir: string, swap: typeof rename): Promise<void> {
  const oldDir = `${outDir}.old-${process.pid}`;
  await rm(oldDir, { recursive: true, force: true });
  const hadOld = await exists(outDir);
  if (hadOld) await rename(outDir, oldDir);
  try {
    await swap(tmpDir, outDir);
  } catch (err) {
    if (hadOld) await rename(oldDir, outDir);
    throw err;
  }
  if (hadOld) await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
}

function describeConflict(c: ResolveConflict): string {
  return `${c.group}:${c.name} requested at ${c.requested.join(", ")}; using ${c.selected}`;
}

/**
 * Resolves the dependencies against the registry, downloads (or reuses cached)
 * archives, and replaces `outDir` with the union of their proto files.
 * Nothing is written to `outDir` unless every artifact verified and every path is safe.
 */
export async function fetchProtos(opts: FetchOptions): Promise<FetchResult> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const outDir = resolve(cwd, opts.outDir);
  await assertSafeOutDir(outDir, opts, cwd);
  const client = new RegistryClient(opts.url, opts.token, opts.timeoutMs);
  const resolution = await client.resolve(opts.repositories, opts.dependencies);
  for (const conflict of resolution.conflicts) opts.warn?.(`Version conflict: ${describeConflict(conflict)}`);

  const extracted: { coordinate: string; files: ProtoFile[] }[] = [];
  for (const artifact of resolution.artifacts) {
    const cachePath = join(opts.cacheDir, `${artifact.sha256}.tar.gz`);
    let data = await readCached(cachePath, artifact.sha256);
    if (!data) {
      const downloaded = await client.download(artifact.archiveUrl);
      const actual = sha256(downloaded.data);
      if (actual !== artifact.sha256 || (downloaded.sha256 !== undefined && downloaded.sha256 !== actual)) {
        throw new CliError(
          `Checksum mismatch for ${artifact.coordinate}: expected ${artifact.sha256}, ` +
            `server header ${downloaded.sha256 ?? "(none)"}, downloaded ${actual}`,
        );
      }
      data = downloaded.data;
      await writeAtomic(cachePath, data);
    }
    try {
      extracted.push({ coordinate: artifact.coordinate, files: await extractArchive(data) });
    } catch (err) {
      throw new CliError(`Invalid archive for ${artifact.coordinate}: ${(err as Error).message}`);
    }
  }

  const placed = placeFiles(extracted);

  const tmpDir = `${outDir}.tmp-${process.pid}`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  try {
    await writeFile(join(tmpDir, OUTPUT_MARKER), "Managed by weaver; this directory is replaced on every fetch.\n");
    for (const { file } of placed) {
      const target = join(tmpDir, ...file.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    await swapIn(tmpDir, outDir, opts.renameFn ?? rename);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
  return { artifacts: resolution.artifacts.length, files: placed.length };
}
