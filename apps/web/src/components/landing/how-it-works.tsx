import type { ReactNode } from "react";
import { Terminal } from "./code-block";
import { Section, SectionHead } from "./layout";

function Prompt({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground select-none">$ </span>
      {children}
    </>
  );
}

function Comment({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground italic">{children}</span>;
}

interface Kind {
  name: string;
  title: string;
  text: ReactNode;
  label: string;
  terminal: ReactNode;
}

function kinds(origin: string, host: string): Kind[] {
  return [
    {
      name: "hosted",
      title: "Publish your own",
      text: "Deploy jars, publish packages and push images to a hosted repository. Releases stay as published unless the repository allows redeploy; Maven snapshots can always be replaced.",
      label: "Pushing to a hosted repository",
      terminal: (
        <>
          <Prompt>docker push {host}/apps/web:1.0</Prompt>
          {"\n"}1.0: digest: sha256:9f2c…e41a size: 1570
        </>
      ),
    },
    {
      name: "mirror",
      title: "Proxy an upstream",
      text: (
        <>
          A read-only proxy of Maven Central, registry.npmjs.org, Docker Hub or any other upstream, tried in order.
          Caching is off by default. Turn it on per mirror to keep what was fetched, refresh metadata after a TTL, evict by
          age and size, and keep serving while the upstream is down.
        </>
      ),
      label: "Pulling through a Docker Hub mirror",
      terminal: (
        <>
          <Prompt>docker pull {host}/hub/nginx:latest</Prompt>
          {"\n"}latest: Pulling from hub/nginx
          {"\n"}Status: Downloaded newer image for {host}/hub/nginx:latest
        </>
      ),
    },
    {
      name: "group",
      title: "One URL for all of it",
      text: "A group puts hosted and mirror repositories of one format behind a single read URL. The first member that has an item answers; Maven metadata and npm package documents are merged.",
      label: "An .npmrc pointing at a group",
      terminal: (
        <>
          registry={origin}/npm/npm-group/
          {"\n"}
          <Comment># @acme packages from hosted, the rest from npmjs</Comment>
        </>
      ),
    },
  ];
}

/** The three repository kinds side by side (stacked on phones), each with a client example. */
export function HowItWorks({ origin, host }: { origin: string; host: string }) {
  return (
    <Section label="how-title">
      <SectionHead id="how-title" eyebrow="Repositories" title="Hosted, mirror and group, in every format.">
        Each repository has one format and one kind. Point a build at a group once; admins can add, reorder or cache its
        members later without anyone changing a build file.
      </SectionHead>
      <ul className="grid overflow-hidden rounded-lg border md:grid-cols-3">
        {kinds(origin, host).map((kind) => (
          <li
            key={kind.name}
            className="grid min-w-0 grid-rows-[auto_auto_auto_1fr] gap-2 border-t p-[22px] first:border-t-0 md:border-t-0 md:border-l md:first:border-l-0"
          >
            <span className="font-mono text-xs font-medium text-muted-foreground">{kind.name}</span>
            <h3 className="text-base font-semibold">{kind.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{kind.text}</p>
            <Terminal label={kind.label} className="mt-2.5 self-end">
              {kind.terminal}
            </Terminal>
          </li>
        ))}
      </ul>
    </Section>
  );
}
