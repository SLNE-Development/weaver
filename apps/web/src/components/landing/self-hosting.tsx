import Link from "next/link";
import { CodeFile } from "./code-block";
import { highlight } from "./highlight";
import { Eyebrow, Section } from "./layout";
import { composeSnippet } from "./samples";

/** One image, your infrastructure: what to bring, and a compose excerpt with this instance's URL. */
export async function SelfHosting({ origin }: { origin: string }) {
  const html = await highlight(composeSnippet(origin), "yaml");
  return (
    <Section id="self-hosting" label="self-hosting-title" innerClassName="grid items-center gap-10 md:grid-cols-2">
      <div>
        <Eyebrow>Self-hosted</Eyebrow>
        <h2 id="self-hosting-title" className="mb-2.5 text-2xl leading-[1.15] font-semibold tracking-[-0.025em] sm:text-[28px]">
          One image, your infrastructure.
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The web app and the worker ship in one Docker image. Bring PostgreSQL, Valkey and S3 or a local volume, put HTTPS
          in front, and serve Weaver at the root of its domain so Docker clients can reach it.
        </p>
        <ul className="mt-4 grid gap-2 text-sm text-muted-foreground">
          <li>
            <b className="font-medium text-foreground">Docker Compose</b> for a single server
          </li>
          <li>
            <b className="font-medium text-foreground">Coolify</b> compose with generated secrets and bundled SeaweedFS
          </li>
          <li>
            <b className="font-medium text-foreground">S3 or local disk</b> for hosted content and mirror caches
          </li>
        </ul>
        <Link
          href="/docs/self-host/compose"
          className="mt-5 inline-flex items-center gap-1 rounded-sm text-sm text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Self-hosting guide
          <span aria-hidden="true">→</span>
        </Link>
      </div>
      <CodeFile file="docker-compose.prod.yml (excerpt)" html={html} className="overflow-hidden rounded-lg border bg-surface" />
    </Section>
  );
}
