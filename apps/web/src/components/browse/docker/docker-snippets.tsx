"use client";

import { dockerSnippets } from "@weaver/docker/client";
import type { Kind } from "@weaver/core";
import { CopyButton } from "@/components/copy-button";
import { SectionTitle } from "@/components/browse-ui";

/** A code block with a title bar and a copy action. */
function SnippetBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-card">
      <div className="flex h-9 items-center gap-2 border-b bg-surface px-3">
        <div className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{title}</div>
        <CopyButton text={code} label={`Copy ${title}`} toastText="Copied to clipboard" />
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** What the snippets need to know about the repository. */
export interface DockerSnippetRepo {
  name: string;
  kind: Kind;
  dockerRoot: boolean;
}

/**
 * The client commands for a docker repository: `docker login`, `docker pull` of the browsed image and tag,
 * `docker push` for hosted repositories and the daemon's `registry-mirrors` setting for the root mirror.
 */
export function DockerSnippets({ url, repo, image, tag }: { url: string; repo: DockerSnippetRepo; image?: string; tag?: string }) {
  const s = dockerSnippets(url, repo, image, tag);
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Use this repository</SectionTitle>
      <p className="text-xs text-muted-foreground">
        Log in with any username and an access token as the password. Image names start with the repository: <code className="text-foreground">{repo.name}/&lt;image&gt;</code>.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <SnippetBlock title="Log in" code={s.login} />
        <SnippetBlock title="Pull" code={s.pull} />
      </div>
      {s.push && <SnippetBlock title="Push" code={s.push} />}
      {s.daemonJson && (
        <>
          <p className="text-xs text-muted-foreground">
            This mirror is the docker root: add it to the Docker daemon&apos;s <code className="text-foreground">/etc/docker/daemon.json</code> and plain{" "}
            <code className="text-foreground">docker pull nginx</code> goes through Weaver.
          </p>
          <SnippetBlock title="daemon.json" code={s.daemonJson} />
        </>
      )}
    </section>
  );
}
