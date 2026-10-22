import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** Raised when appending to a spool file fails; `persisted` bytes of the failed append were kept. */
export class SpoolError extends Error {
  /** Wraps `cause`, recording how many bytes of the failed append reached the file intact. */
  constructor(
    readonly persisted: number,
    cause: unknown,
  ) {
    super(`spool append failed after ${persisted} bytes`, { cause });
    this.name = "SpoolError";
  }
}

/** Raised when a spool file's length is not the offset the caller expected. */
export class SpoolOffsetError extends Error {
  /** Records the actual file length. */
  constructor(readonly actual: number) {
    super(`spool file holds ${actual} bytes`);
    this.name = "SpoolOffsetError";
  }
}

/** The spool file of upload `id` in `uploadDir`. */
export function spoolPath(uploadDir: string, id: string): string {
  return join(uploadDir, id);
}

/** Creates an empty spool file at `path`, creating its directory as needed. */
export async function createSpool(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
}

/** Deletes a spool file; does nothing when it does not exist. */
export function removeSpool(path: string): Promise<void> {
  return rm(path, { force: true });
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/** Resolves once `ws` has closed its file descriptor, so its completed writes are on disk. */
function closed(ws: WriteStream): Promise<void> {
  if (ws.closed) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", () => resolve()));
}

/**
 * Pipes a web ReadableStream to the end of a file; returns bytes written. Aborted/failed streams truncate
 * back to the previous length plus the writes that completed (always a prefix of the body), and reject
 * with a {@link SpoolError} carrying that count, so an interrupted upload resumes from what was received.
 * Bytes beyond `expectedStart` left by an earlier crash are cut first; a file shorter than `expectedStart`
 * rejects with {@link SpoolOffsetError}. The body is streamed with backpressure, never buffered whole.
 */
export async function appendToSpool(path: string, body: ReadableStream<Uint8Array>, expectedStart: number): Promise<number> {
  const before = await sizeOf(path);
  if (before < expectedStart) throw new SpoolOffsetError(before);
  if (before > expectedStart) await truncate(path, expectedStart);

  const ws = createWriteStream(path, { flags: "a" });
  try {
    await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>), ws);
  } catch (err) {
    await closed(ws);
    // Keep only fully completed writes: a half-written chunk would corrupt the resumed upload.
    const kept = Math.min(Math.max((await sizeOf(path)) - expectedStart, 0), ws.bytesWritten);
    await truncate(path, expectedStart + kept).catch(() => undefined);
    throw new SpoolError(kept, err);
  }
  return ws.bytesWritten;
}
