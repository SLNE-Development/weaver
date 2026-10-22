import { RegistryError, type Repo } from "@weaver/core";
import { checksumText } from "./checksum.js";
import type { MavenContext } from "./context.js";
import { hostedMetadataXml } from "./generate.js";
import { generatedResponse, readHosted } from "./hosted.js";
import { mergeArtifactMetadata, parseMetadata, renderArtifactMetadata, renderPluginMetadata, renderSnapshotMetadata, type ParsedMetadata, type PluginEntry } from "./metadata.js";
import { mirrorMetadataXml, readMirror } from "./mirror.js";
import type { MavenPath } from "./path.js";

/** A Maven path that names a file (not a directory). */
type GroupTarget = Exclude<MavenPath, { type: "directory" }>;

/** Whether an error is an unreachable or refusing upstream. */
function isUnavailable(err: unknown): err is RegistryError {
  return err instanceof RegistryError && err.code === "upstream_unavailable";
}

/** The members of a group that can serve content (hosted and mirror repositories), in order. */
async function servingMembers(ctx: MavenContext, group: Repo): Promise<Repo[]> {
  return (await ctx.deps.repos.members(group.id)).filter((m) => m.kind === "hosted" || m.kind === "mirror");
}

/** One member's metadata XML for a directory. */
function memberMetadataXml(ctx: MavenContext, member: Repo, dir: string): Promise<string | null> {
  return member.kind === "mirror" ? mirrorMetadataXml(ctx, member, dir) : hostedMetadataXml(ctx.deps, member, dir);
}

/** Unions plugin entries by prefix; earlier documents win. */
function mergePlugins(lists: PluginEntry[][]): PluginEntry[] {
  const byPrefix = new Map<string, PluginEntry>();
  for (const list of lists) for (const p of list) if (!byPrefix.has(p.prefix)) byPrefix.set(p.prefix, p);
  return [...byPrefix.values()];
}

/** Merges parsed documents of one directory into one rendered document. */
function renderMerged(docs: ParsedMetadata[]): string {
  const first = docs[0]!;
  if (first.kind === "artifact") {
    const same = docs.flatMap((d) => (d.kind === "artifact" ? [d.value] : []));
    return renderArtifactMetadata(mergeArtifactMetadata(same));
  }
  if (first.kind === "snapshot") {
    const same = docs.flatMap((d) => (d.kind === "snapshot" ? [d.value] : []));
    return renderSnapshotMetadata(same.reduce((best, d) => (d.lastUpdated > best.lastUpdated ? d : best)));
  }
  return renderPluginMetadata(mergePlugins(docs.flatMap((d) => (d.kind === "plugins" ? [d.plugins] : []))));
}

/**
 * Merged metadata XML across the members of a group for a directory, or null when no member has
 * any. Members whose upstream fails are skipped (and logged); when no member has metadata and at
 * least one failed, `upstream_unavailable` is thrown, because clients cache a 404 negatively.
 */
export async function groupMetadataXml(ctx: MavenContext, group: Repo, dir: string): Promise<string | null> {
  const docs: ParsedMetadata[] = [];
  let failed = 0;
  let asked = 0;
  for (const member of await servingMembers(ctx, group)) {
    asked++;
    let xml: string | null;
    try {
      xml = await memberMetadataXml(ctx, member, dir);
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      failed++;
      console.warn(`weaver: group ${group.name} skipped member ${member.name}: ${err.message}`);
      continue;
    }
    const parsed = xml === null ? null : parseMetadata(xml);
    if (parsed) docs.push(parsed);
  }
  if (docs.length === 0) {
    if (failed > 0) throw new RegistryError("upstream_unavailable", `${failed} of ${asked} members of ${group.name} are unavailable and none has this metadata`);
    return null;
  }
  return renderMerged(docs.filter((d) => d.kind === docs[0]!.kind));
}

/**
 * Serves a file from a group: metadata is merged across members, anything else comes from the
 * first member that has it. A member with an unavailable upstream is skipped; if nothing is found
 * and one failed, the failure is rethrown. null = not found in any member.
 */
export async function readGroup(ctx: MavenContext, group: Repo, target: GroupTarget): Promise<Response | null> {
  if (target.type === "metadata") {
    const xml = await groupMetadataXml(ctx, group, target.dir);
    if (xml === null) return null;
    if (target.checksum !== null) return generatedResponse(ctx, checksumText(xml, target.checksum), "text/plain");
    return generatedResponse(ctx, xml, "application/xml");
  }
  let failure: unknown = null;
  for (const member of await servingMembers(ctx, group)) {
    try {
      const res = member.kind === "mirror" ? await readMirror(ctx, member, target) : await readHosted(ctx, member, target);
      if (res) return res;
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      failure ??= err;
    }
  }
  if (failure) throw failure;
  return null;
}
