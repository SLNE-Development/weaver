/** A whole buffer as a single-chunk byte stream. */
export function streamOf(data: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      controller.close();
    },
  });
}

/** Thrown by {@link readAllLimited} when a stream holds more than its limit. */
export class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`More than ${maxBytes} bytes`);
    this.name = "TooLargeError";
  }
}

/**
 * Reads `body` to its end into one buffer, cancelling it and throwing {@link TooLargeError} as soon
 * as it exceeds `maxBytes`. A null body reads as empty.
 */
export async function readAllLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
  if (body === null) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
