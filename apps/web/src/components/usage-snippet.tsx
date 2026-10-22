import { env } from "@/env";
import { gradleSnippet, weaverJsonSnippet } from "@/lib/browse";
import { CodeBlock } from "./code-block";

/**
 * How to consume a version, or with no `coordinate` a whole repository: the Gradle plugin setup
 * (`repositories("<repository>")`, `weaver("g:n:v")`) and a `weaver.json` for the CLI. The URL is
 * the public base URL from the environment.
 */
export function UsageSnippet({
  repository,
  coordinate,
  stacked = false,
}: {
  repository: string;
  coordinate?: string;
  /** One column even on wide screens. */
  stacked?: boolean;
}) {
  const input = { url: env.BETTER_AUTH_URL, repository, coordinate };
  return (
    <div className={stacked ? "grid gap-4" : "grid gap-4 lg:grid-cols-2"}>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Gradle, with the <code className="text-foreground">dev.slne.weaver</code> plugin, in <code className="text-foreground">build.gradle.kts</code>
        </p>
        <CodeBlock code={gradleSnippet(input)} lang="kotlin" title="build.gradle.kts" copyLabel="Copy Gradle snippet" />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Node, for <code className="text-foreground">weaver fetch</code> (token from <code className="text-foreground">WEAVER_TOKEN</code>)
        </p>
        <CodeBlock code={weaverJsonSnippet(input)} lang="json" title="weaver.json" copyLabel="Copy weaver.json" />
      </div>
    </div>
  );
}
