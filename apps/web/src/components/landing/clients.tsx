import Link from "next/link";
import { CodeFile } from "./code-block";
import { highlight } from "./highlight";
import { Section, SectionHead } from "./layout";
import { cliConfig, dockerDaemonJson, mavenGroupSettings, npmPublish } from "./samples";

interface FormatCard {
  title: string;
  clients: string;
  docs: string;
  points: string[];
  file: string;
  html: string;
}

function ClientCard({ card }: { card: FormatCard }) {
  return (
    <article className="grid min-w-0 grid-rows-[auto_auto_1fr] overflow-hidden rounded-lg border">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <h3 className="font-semibold">
          <Link href={card.docs} className="rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
            {card.title}
          </Link>
        </h3>
        <span className="font-mono text-xs text-muted-foreground">{card.clients}</span>
      </header>
      <ul className="grid gap-1.5 px-4 py-3.5 text-[13.5px] leading-relaxed text-muted-foreground">
        {card.points.map((point) => (
          <li key={point} className="flex gap-2">
            <span aria-hidden="true" className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
      <CodeFile file={card.file} html={card.html} className="self-end border-t bg-surface" />
    </article>
  );
}

/** What each format supports, with one more snippet per format filled in with this instance's URL. */
export async function Clients({ origin }: { origin: string }) {
  const [maven, npm, docker, proto] = await Promise.all([
    highlight(mavenGroupSettings(origin), "xml"),
    highlight(npmPublish(origin), "shellscript"),
    highlight(dockerDaemonJson(origin), "json"),
    highlight(cliConfig(origin), "json"),
  ]);

  const cards: FormatCard[] = [
    {
      title: "Maven",
      clients: "mvn · Gradle",
      docs: "/docs/maven",
      points: [
        "Releases and snapshots, with a version policy and a redeploy switch per repository.",
        "Gradle module metadata is stored and served, so variant-aware resolution works.",
        "Checksums are generated when a client didn't upload them.",
      ],
      file: "~/.m2/settings.xml",
      html: maven,
    },
    {
      title: "npm",
      clients: "npm · pnpm · yarn · bun",
      docs: "/docs/npm",
      points: [
        "npm login opens the browser, where you approve the new token.",
        "Scoped packages, dist-tags, deprecate and unpublish.",
        "npm audit is passed through to the upstream of a mirror.",
      ],
      file: "terminal",
      html: npm,
    },
    {
      title: "Docker and OCI",
      clients: "docker · podman · buildx · helm",
      docs: "/docs/docker",
      points: [
        "Images live under the repository name on the same domain: <host>/<repo>/<image>.",
        "A Docker Hub mirror can be the daemon's registry-mirrors entry.",
        "OCI artifacts, Helm charts, signatures and SBOMs; layers are garbage-collected.",
      ],
      file: "/etc/docker/daemon.json",
      html: docker,
    },
    {
      title: "proto",
      clients: "Gradle plugin · weaver CLI",
      docs: "/docs/gradle",
      points: [
        "Versioned bundles of .proto files, checked to compile on every publish.",
        "The Gradle plugin dev.slne.weaver publishes and fetches them.",
        "Node projects fetch the same bundles with @slne/weaver-cli.",
      ],
      file: "weaver.json",
      html: proto,
    },
  ];

  return (
    <Section label="clients-title">
      <SectionHead id="clients-title" eyebrow="Formats" title="Four formats, the clients you already use.">
        Maven, npm and Docker speak their own registry protocols, so stock tools need only a URL and a token. Proto keeps
        its own format, with a Gradle plugin and a small CLI.
      </SectionHead>
      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((card) => (
          <ClientCard key={card.title} card={card} />
        ))}
      </div>
    </Section>
  );
}
