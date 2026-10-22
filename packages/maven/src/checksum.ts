import { createHash } from "node:crypto";
import type { AssetRow } from "@weaver/core";
import { CHECKSUM_ALGOS, type ChecksumAlgo } from "./path.js";

/** The lowercase hex digest of a stored asset, as recorded when it was written. */
export function digestOf(asset: AssetRow, algo: ChecksumAlgo): string {
  return asset[algo];
}

/** The lowercase hex digest of a string's UTF-8 bytes. */
export function checksumText(text: string, algo: ChecksumAlgo): string {
  return createHash(algo).update(text, "utf8").digest("hex");
}

/**
 * Whether a missing checksum of `basePath` may be generated: never for checksums of checksums
 * or of `.asc` signatures (those exist only when uploaded).
 */
export function checksumGeneratable(basePath: string): boolean {
  return !basePath.endsWith(".asc") && !CHECKSUM_ALGOS.some((algo) => basePath.endsWith(`.${algo}`));
}
