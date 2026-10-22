import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProtoFile } from "./archive.js";

/** A single problem found while validating proto files. */
export interface ValidationIssue {
  path: string;
  line?: number;
  column?: number;
  message: string;
}

// Obtained at runtime rather than imported: bundlers (Next.js/Turbopack) rewrite
// `createRequire(import.meta.url).resolve("...")` into internal module ids, which breaks
// locating the buf binary on disk.
const { createRequire } = process.getBuiltinModule("node:module");
const runtimeRequire = createRequire(import.meta.url);

const PLATFORM_PACKAGES: Record<string, string> = {
  "win32 arm64": "@bufbuild/buf-win32-arm64",
  "win32 x64": "@bufbuild/buf-win32-x64",
  "darwin arm64": "@bufbuild/buf-darwin-arm64",
  "darwin x64": "@bufbuild/buf-darwin-x64",
  "linux arm64": "@bufbuild/buf-linux-aarch64",
  "linux arm": "@bufbuild/buf-linux-armv7",
  "linux x64": "@bufbuild/buf-linux-x64",
};

let cachedBufBinary: string | undefined;

/**
 * Resolves the buf executable shipped by the platform package of `@bufbuild/buf`.
 * The platform map mirrors the one in `@bufbuild/buf/install.js`; keep them in sync on upgrades.
 */
function resolveBufBinary(): string {
  if (cachedBufBinary) return cachedBufBinary;
  const key = `${process.platform} ${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) throw new Error(`buf is not available for platform ${key}`);
  const bufRequire = createRequire(runtimeRequire.resolve("@bufbuild/buf/package.json"));
  const pkgDir = dirname(bufRequire.resolve(`${pkg}/package.json`));
  cachedBufBinary = join(pkgDir, "bin", process.platform === "win32" ? "buf.exe" : "buf");
  return cachedBufBinary;
}

interface BufIssue {
  path?: string;
  start_line?: number;
  start_column?: number;
  message?: string;
}

interface BufResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runBuf(cwd: string, args: string[]): Promise<BufResult> {
  return new Promise((resolve, reject) => {
    // The binary path is only known at runtime; tell bundlers (Next.js/Turbopack) not to trace it,
    // otherwise they pull the whole project into the deployment. Apps ship the buf platform
    // package explicitly (see apps/web next.config.ts `outputFileTracingIncludes`).
    execFile(
      /* turbopackIgnore: true */ resolveBufBinary(),
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : 0 });
      },
    );
  });
}

async function writeFiles(root: string, files: ProtoFile[]): Promise<void> {
  const targets = files.map((file) => ({
    target: join(root, ...file.path.split("/")),
    content: file.content,
  }));
  await mkdir(root, { recursive: true });
  for (const dir of new Set(targets.map((t) => dirname(t.target)))) {
    await mkdir(dir, { recursive: true });
  }
  // Bounded batches keep open file descriptors well below typical limits (EMFILE).
  const batchSize = 64;
  for (let i = 0; i < targets.length; i += batchSize) {
    await Promise.all(
      targets.slice(i, i + batchSize).map((t) => writeFile(t.target, t.content, "utf8")),
    );
  }
}

function parseIssues(output: string, files: ProtoFile[], dependencyFiles: ProtoFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const raw of output.split("\n")) {
    const text = raw.trim();
    if (!text) continue;
    let parsed: BufIssue;
    try {
      parsed = JSON.parse(text) as BufIssue;
    } catch {
      issues.push({ path: "", message: text });
      continue;
    }
    const normalized = (parsed.path ?? "").replaceAll("\\", "/");
    const inDependency = normalized.startsWith("deps/");
    const path = normalized.replace(/^(src|deps)\//, "");
    let message = parsed.message ?? "Unknown validation error";
    if (parsed.start_line && /does not exist/.test(message)) {
      // buf omits the import path from this message; recover it from the source line.
      const content = (inDependency ? dependencyFiles : files).find((f) => f.path === path)?.content;
      const source = content?.split("\n")[parsed.start_line - 1];
      const imported = source ? /"([^"]+)"/.exec(source)?.[1] : undefined;
      if (imported) message = `${message}: ${imported}`;
    }
    const issue: ValidationIssue = {
      path,
      message: inDependency ? `in dependency: ${message}` : message,
    };
    if (parsed.start_line) issue.line = parsed.start_line;
    if (parsed.start_column) issue.column = parsed.start_column;
    issues.push(issue);
  }
  return issues;
}

/** Returns why a path cannot be written safely, or undefined when it is acceptable. */
function pathProblem(path: string): string | undefined {
  if (
    path === "" ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `Invalid path: ${path} must be a normalized relative path`;
  }
  if (path.toLowerCase().startsWith("google/protobuf/")) {
    return `Reserved path: ${path} is reserved for protobuf well-known types`;
  }
  return undefined;
}

/**
 * Compiles `files` with buf, resolving imports against `dependencyFiles` and the
 * well-known types. Returns an empty array when everything is valid.
 */
export async function validateProtos(input: {
  files: ProtoFile[];
  dependencyFiles: ProtoFile[];
}): Promise<ValidationIssue[]> {
  const rejected: ValidationIssue[] = [];
  for (const file of [...input.files, ...input.dependencyFiles]) {
    const problem = pathProblem(file.path);
    if (problem) rejected.push({ path: file.path, message: problem });
  }
  if (rejected.length > 0) return rejected;

  const dependencyPaths = new Set(input.dependencyFiles.map((f) => f.path));
  const duplicates = input.files
    .filter((f) => dependencyPaths.has(f.path))
    .map<ValidationIssue>((f) => ({
      path: f.path,
      message: `Duplicate file: ${f.path} is present in both the package and its dependencies`,
    }));
  if (duplicates.length > 0) return duplicates;
  if (input.files.length === 0) return [];

  const root = await mkdtemp(join(tmpdir(), "weaver-validate-"));
  try {
    await writeFiles(join(root, "src"), input.files);
    // buf rejects a module without .proto files, so deps is only declared when it has some.
    const hasDeps = input.dependencyFiles.length > 0;
    if (hasDeps) await writeFiles(join(root, "deps"), input.dependencyFiles);
    await writeFile(
      join(root, "buf.yaml"),
      `version: v2\nmodules:\n  - path: src\n${hasDeps ? "  - path: deps\n" : ""}`,
      "utf8",
    );
    const result = await runBuf(root, [
      "build",
      "--error-format",
      "json",
      "-o",
      "-",
    ]);
    if (result.code === 0) return [];
    const issues = parseIssues(result.stderr || result.stdout, input.files, input.dependencyFiles);
    return issues.length > 0
      ? issues
      : [{ path: "", message: `buf exited with code ${result.code}` }];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
