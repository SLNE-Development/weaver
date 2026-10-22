import { DockerError } from "./errors.js";
import { MANIFEST_MEDIA_TYPES, isDigest } from "./media-types.js";

/** The platform an image manifest or index entry targets. */
export interface Platform {
  os: string;
  architecture: string;
  variant?: string;
}

/** An OCI content descriptor: what a manifest references (blob, child manifest or subject). */
export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  platform?: Platform;
  artifactType?: string;
  annotations?: Record<string, string>;
  urls?: string[];
}

/** The parts of a pushed manifest the registry works with. */
export interface ParsedManifest {
  mediaType: string;
  /** True for a Docker manifest list or OCI image index. */
  isIndex: boolean;
  /** The config descriptor of an image manifest; null for an index. */
  config: Descriptor | null;
  layers: Descriptor[];
  /** The children of an index; empty for an image manifest. */
  manifests: Descriptor[];
  subject: Descriptor | null;
  artifactType: string | null;
  annotations: Record<string, string> | null;
}

const INDEX_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
]);

function invalid(message: string, detail?: unknown): DockerError {
  return new DockerError(400, "MANIFEST_INVALID", message, detail ?? null);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The media type of a Content-Type header without parameters, or null when absent. */
function bareType(contentType: string | null): string | null {
  const t = contentType?.split(";")[0]!.trim().toLowerCase();
  return t ? t : null;
}

function stringMap(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v) || !Object.values(v).every((x) => typeof x === "string")) {
    throw invalid(`${where}.annotations must map strings to strings`);
  }
  return v as Record<string, string>;
}

function optionalString(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw invalid(`${where} must be a string`);
  return v;
}

function platformOf(v: unknown, where: string): Platform | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v) || typeof v.os !== "string" || typeof v.architecture !== "string") {
    throw invalid(`${where}.platform needs os and architecture`);
  }
  const platform: Platform = { os: v.os, architecture: v.architecture };
  const variant = optionalString(v.variant, `${where}.platform.variant`);
  if (variant) platform.variant = variant;
  return platform;
}

/** Validates one descriptor at `where` and keeps only the fields the registry uses. */
function descriptorOf(v: unknown, where: string): Descriptor {
  if (!isObject(v)) throw invalid(`${where} must be a descriptor`);
  const { mediaType, digest, size } = v;
  if (typeof mediaType !== "string" || mediaType === "") throw invalid(`${where}.mediaType is required`);
  if (typeof digest !== "string" || !isDigest(digest)) throw invalid(`${where}.digest is invalid`, { digest });
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw invalid(`${where}.size is invalid`);
  const d: Descriptor = { mediaType, digest, size };
  const platform = platformOf(v.platform, where);
  if (platform) d.platform = platform;
  const artifactType = optionalString(v.artifactType, `${where}.artifactType`);
  if (artifactType) d.artifactType = artifactType;
  const annotations = stringMap(v.annotations, where);
  if (annotations) d.annotations = annotations;
  if (v.urls !== undefined && v.urls !== null) {
    if (!Array.isArray(v.urls) || !v.urls.every((u) => typeof u === "string")) throw invalid(`${where}.urls must be strings`);
    if (v.urls.length > 0) d.urls = v.urls as string[];
  }
  return d;
}

function descriptorList(v: unknown, where: string): Descriptor[] {
  if (!Array.isArray(v)) throw invalid(`${where} must be an array`);
  return v.map((d, i) => descriptorOf(d, `${where}[${i}]`));
}

/**
 * Validates JSON shape and media type (Content-Type must match `mediaType` when present). Throws DockerError MANIFEST_INVALID.
 * The match is enforced only for a Content-Type that is itself a manifest media type.
 * Accepts Docker v2 schema 2 manifests and manifest lists and OCI image manifests and indexes; schema 1 is rejected.
 * A body without `mediaType` takes it from the Content-Type, or from its shape when neither names a manifest type.
 */
export function parseManifest(bytes: Buffer, contentType: string | null): ParsedManifest {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("manifest is not valid JSON");
  }
  if (!isObject(json)) throw invalid("manifest must be a JSON object");
  if (json.schemaVersion !== 2) throw invalid("only schemaVersion 2 manifests are supported", { schemaVersion: json.schemaVersion ?? null });

  const header = bareType(contentType);
  const declared = optionalString(json.mediaType, "mediaType");
  // Only a manifest-typed Content-Type must agree; a generic one (application/json, octet-stream) defers to the body.
  if (declared && header && MANIFEST_MEDIA_TYPES.includes(header) && declared !== header) {
    throw invalid("Content-Type does not match the manifest mediaType", { contentType: header, mediaType: declared });
  }
  let mediaType = declared ?? (header && MANIFEST_MEDIA_TYPES.includes(header) ? header : undefined);
  if (!mediaType) {
    mediaType = Array.isArray(json.manifests) ? "application/vnd.oci.image.index.v1+json" : "application/vnd.oci.image.manifest.v1+json";
  }
  if (!MANIFEST_MEDIA_TYPES.includes(mediaType)) throw invalid("unsupported manifest media type", { mediaType });

  const isIndex = INDEX_TYPES.has(mediaType);
  const parsed: ParsedManifest = {
    mediaType,
    isIndex,
    config: null,
    layers: [],
    manifests: [],
    subject: json.subject === undefined || json.subject === null ? null : descriptorOf(json.subject, "subject"),
    artifactType: optionalString(json.artifactType, "artifactType") ?? null,
    annotations: stringMap(json.annotations, "manifest") ?? null,
  };
  if (isIndex) {
    parsed.manifests = descriptorList(json.manifests, "manifests");
  } else {
    parsed.config = descriptorOf(json.config, "config");
    parsed.layers = json.layers === undefined ? [] : descriptorList(json.layers, "layers");
  }
  return parsed;
}
