import "server-only";

import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { loginPath } from "@/lib/access";
import { artifactHref, repositoryHref } from "@/lib/browse";
import { api } from "@/trpc/server";

/**
 * When `repo` is a proto group, redirects to the page of the artifact (or version) in the first
 * member that serves it; otherwise returns. Proto groups have no artifact pages of their own.
 */
export async function redirectToGroupMember(repo: string, group: string, name: string, version?: string): Promise<void> {
  const member = await api.browse.protoGroupMember({ repository: repo, group, name, version }).catch(() => null);
  if (member) redirect(artifactHref(member, group, name, version));
}

/**
 * When `repo` is a docker group, redirects to the image (or manifest) in the first member that
 * stores it; otherwise returns. Docker groups list no images of their own.
 */
export async function redirectToDockerGroupMember(repo: string, image: string, digest?: string): Promise<void> {
  const member = await api.docker.groupMember({ repo, image, digest }).catch(() => null);
  if (!member) return;
  const params = new URLSearchParams({ image });
  if (digest) params.set("digest", digest);
  redirect(`${repositoryHref(member)}?${params.toString()}`);
}

/**
 * Awaits a tRPC call of the page at `path` and maps the expected failures to pages:
 * `UNAUTHORIZED` (signed out, or anonymous view switched off) goes to the login page and back;
 * `NOT_FOUND`, `FORBIDDEN` and `BAD_REQUEST` (malformed path segments) show the 404 page. Private
 * repositories answer `NOT_FOUND` to outsiders, so nothing is disclosed.
 */
export async function orNotFound<T>(call: Promise<T>, path: string): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === "UNAUTHORIZED") redirect(loginPath(path));
      if (error.code === "NOT_FOUND" || error.code === "FORBIDDEN" || error.code === "BAD_REQUEST") notFound();
    }
    throw error;
  }
}
