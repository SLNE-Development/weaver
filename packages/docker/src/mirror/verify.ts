import { createHash } from "node:crypto";

/** Whether `digest` (`sha256:<hex>` or `sha512:<hex>`) names the content an asset with these digests holds. */
export function digestMatches(row: { sha256: string; sha512: string }, digest: string): boolean {
  const [algorithm, hex] = digest.split(":");
  if (algorithm === "sha256") return row.sha256 === hex;
  if (algorithm === "sha512") return row.sha512 === hex;
  return false;
}

/**
 * Passes `source` through while hashing it, so that content not matching `digest` is never delivered whole.
 * With a known `length` the check runs before the last chunk is passed on: on a mismatch the source is
 * cancelled (which aborts a cache write fed from the same upstream body) and the stream errors. Without
 * one it runs at the end. `onMismatch` is called once when the content does not match.
 */
export function verifyDigest(
  source: ReadableStream<Uint8Array>,
  digest: string,
  length: number | undefined,
  onMismatch: () => void,
): ReadableStream<Uint8Array> {
  const [algorithm, hex] = digest.split(":") as [string, string];
  const hash = createHash(algorithm);
  const reader = source.getReader();
  let total = 0;
  const mismatch = () => new Error(`weaver:docker upstream content does not match ${digest}`);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if ((length !== undefined && total !== length) || hash.digest("hex") !== hex) {
          onMismatch();
          controller.error(mismatch());
          return;
        }
        controller.close();
        return;
      }
      total += value.byteLength;
      hash.update(value);
      if (length !== undefined && total >= length && (total > length || hash.copy().digest("hex") !== hex)) {
        onMismatch();
        const error = mismatch();
        await reader.cancel(error).catch(() => undefined);
        controller.error(error);
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
