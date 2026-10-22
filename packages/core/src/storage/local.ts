import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { HashingStream, toReadable } from "./hashing.js";
import { resolveRange, type ObjectStore } from "./object-store.js";

/**
 * Object store backed by a directory on the local filesystem; keys map to relative paths under `root`.
 * Puts stream into `<key>.tmp-<uuid>` and rename into place, so readers never see a partial object.
 */
export function createLocalStore(root: string): ObjectStore {
  const base = resolve(root);

  /** Maps a key to an absolute path inside `root`, rejecting anything that could escape it. */
  function pathFor(key: string): string {
    if (key === "" || key.includes("\0")) throw new Error("Invalid storage key: must be non-empty");
    // Only a whole ".." segment can climb out; names like "foo..bar" are fine.
    if (key.split(/[/\\]/).includes("..")) {
      throw new Error(`Invalid storage key "${key}": must not contain ".." segments`);
    }
    if (isAbsolute(key) || key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`Invalid storage key "${key}": must be relative`);
    }
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) {
      throw new Error(`Invalid storage key "${key}": resolves outside the storage root`);
    }
    return full;
  }

  return {
    id: "local",

    async put(key, body, opts = {}) {
      const target = pathFor(key);
      opts.signal?.throwIfAborted();
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${randomUUID()}`;
      const hasher = new HashingStream(opts.contentLength);
      try {
        await pipeline(toReadable(body), hasher, createWriteStream(tmp), { signal: opts.signal });
        const result = hasher.result();
        // An abort that lands after the last write must still leave no object.
        opts.signal?.throwIfAborted();
        await rename(tmp, target);
        return result;
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },

    async get(key, opts = {}) {
      const path = pathFor(key);
      let handle;
      try {
        handle = await open(path, "r");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) {
          await handle.close();
          return null;
        }
        const size = info.size;
        if (!opts.range) return { body: handle.createReadStream(), size };
        const range = resolveRange(opts.range, size);
        return { body: handle.createReadStream({ start: range.start, end: range.end }), size, range };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },

    async head(key) {
      try {
        const info = await stat(pathFor(key));
        return info.isFile() ? { size: info.size } : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },

    async deleteMany(keys) {
      const paths = keys.map(pathFor);
      await Promise.all(paths.map((path) => rm(path, { force: true })));
    },
  };
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
