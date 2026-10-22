import { createHash, type Hash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import type { PutResult } from "./object-store.js";

/**
 * Pass-through stream that computes md5, sha1, sha256 and sha512 and counts bytes of everything
 * flowing through it. `result()` is available once the stream has flushed. With `expectedLength`
 * the stream errors as soon as more bytes arrive, or at the end when fewer did, so a store reading
 * from it fails before committing a wrong-sized object.
 */
export class HashingStream extends Transform {
  readonly #expectedLength: number | undefined;
  readonly #hashes: Record<"md5" | "sha1" | "sha256" | "sha512", Hash> = {
    md5: createHash("md5"),
    sha1: createHash("sha1"),
    sha256: createHash("sha256"),
    sha512: createHash("sha512"),
  };
  #bytes = 0;
  #digests: PutResult | null = null;

  constructor(expectedLength?: number) {
    super();
    this.#expectedLength = expectedLength;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytes += chunk.length;
    if (this.#expectedLength !== undefined && this.#bytes > this.#expectedLength) {
      callback(lengthMismatch(this.#bytes, this.#expectedLength, "at least "));
      return;
    }
    for (const hash of Object.values(this.#hashes)) hash.update(chunk);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.#expectedLength !== undefined && this.#bytes !== this.#expectedLength) {
      callback(lengthMismatch(this.#bytes, this.#expectedLength, ""));
      return;
    }
    const { md5, sha1, sha256, sha512 } = this.#hashes;
    this.#digests = {
      size: this.#bytes,
      md5: md5.digest("hex"),
      sha1: sha1.digest("hex"),
      sha256: sha256.digest("hex"),
      sha512: sha512.digest("hex"),
    };
    callback();
  }

  /** Size and lowercase-hex digests of all bytes seen; throws when the stream has not finished. */
  result(): PutResult {
    if (!this.#digests) throw new Error("HashingStream.result() called before the stream finished");
    return this.#digests;
  }
}

/** Wraps a buffer in a stream so stores can treat buffer and stream bodies the same way. */
export function toReadable(body: Readable | Buffer): Readable {
  return Buffer.isBuffer(body) ? Readable.from([body]) : body;
}

function lengthMismatch(actual: number, expected: number, qualifier: string): Error {
  return new Error(`Body was ${qualifier}${actual} bytes but contentLength declared ${expected}`);
}
