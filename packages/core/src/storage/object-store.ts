import type { Readable } from "node:stream";

/** Every storage backend id, in the order `local`, `s3`. */
export const STORE_IDS = ["local", "s3"] as const;

/** Identifies a configured storage backend. */
export type StoreId = (typeof STORE_IDS)[number];

/** Lowercase-hex digests of an object's bytes. */
export interface ObjectDigests {
  md5: string;
  sha1: string;
  sha256: string;
  sha512: string;
}

/** What a completed `put` wrote: the byte count and all digests. */
export interface PutResult extends ObjectDigests {
  size: number;
}

/** Metadata of a stored object. */
export interface ObjectInfo {
  size: number;
}

/** An opened object; `size` is always the full object size, also for range reads. */
export interface ObjectRead {
  body: Readable;
  size: number;
  /** Present when a range was requested: the inclusive byte range `body` covers. */
  range?: { start: number; end: number };
}

/**
 * Streaming object storage. Keys are slash-separated relative paths; the proto registry writes
 * `{repository}/{group}/{name}/{version}/{uuid}.tar.gz` and stores the key on the build row.
 */
export interface ObjectStore {
  readonly id: StoreId;
  /**
   * Streams `body` to `key`, hashing on the way; the object only becomes visible once fully written.
   * When `contentLength` is given and the body has a different length, the put fails and writes nothing.
   * Aborting `signal` rejects the put and leaves no object.
   */
  put(key: string, body: Readable | Buffer, opts?: { contentLength?: number; signal?: AbortSignal }): Promise<PutResult>;
  /**
   * Opens `key` for reading; resolves to `null` when it does not exist. `range` is inclusive and an
   * omitted `end` reads to the end; an end past the object is clamped. A range starting at or past
   * the end of the object rejects with a `RangeError`.
   */
  get(key: string, opts?: { range?: { start: number; end?: number } }): Promise<ObjectRead | null>;
  /** Resolves to the object's size, or `null` when it does not exist. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Deletes `key`; does not throw when it does not exist. */
  delete(key: string): Promise<void>;
  /** Deletes all `keys`, ignoring missing ones. */
  deleteMany(keys: string[]): Promise<void>;
}

/** The configured stores: `primary` receives hosted writes, `get` returns any configured one. */
export interface StoreSet {
  primary: ObjectStore;
  /** The store with `id`, or `null` when it is not configured. */
  get(id: StoreId): ObjectStore | null;
  /** Ids of all configured stores, in the order `local`, `s3`. */
  configured(): StoreId[];
}

/** Writes a whole in-memory buffer to `key`. */
export function putBuffer(store: ObjectStore, key: string, data: Buffer): Promise<PutResult> {
  return store.put(key, data, { contentLength: data.length });
}

/** Reads the whole object at `key` into memory; resolves to `null` when it does not exist. */
export async function getBuffer(store: ObjectStore, key: string): Promise<Buffer | null> {
  const read = await store.get(key);
  if (!read) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of read.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/** Resolves an inclusive request range against an object of `size` bytes; throws `RangeError` when unsatisfiable. */
export function resolveRange(range: { start: number; end?: number }, size: number): { start: number; end: number } {
  const { start } = range;
  if (!Number.isInteger(start) || start < 0 || (range.end !== undefined && (!Number.isInteger(range.end) || range.end < start))) {
    throw new RangeError(`Invalid range ${start}-${range.end ?? ""}`);
  }
  if (start >= size) throw new RangeError(`Range start ${start} is not within an object of ${size} bytes`);
  return { start, end: Math.min(range.end ?? size - 1, size - 1) };
}
