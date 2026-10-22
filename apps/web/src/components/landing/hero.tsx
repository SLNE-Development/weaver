import Link from "next/link";
import { Button } from "@weaver/ui/components/button";
import type { SocialProviderId } from "@/server/auth";
import type { PublicStats } from "@/lib/public-catalog";
import { HeroCards, type HighlightedFormat } from "./hero-cards";
import { highlight } from "./highlight";
import { Container, Eyebrow } from "./layout";
import { heroSamples } from "./samples";
import { SignInButtons } from "./sign-in-buttons";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** Where each format's clients point, in the order of {@link heroSamples}. */
function clientUrls(origin: string, host: string): string[] {
  return [`${origin}/maven/<repo>/`, `${origin}/npm/<repo>/`, `${host}/<repo>/<image>:<tag>`, `${origin}/api/v1 via the Gradle plugin or CLI`];
}

/** First screen: what Weaver is, the way in, and a client card with one tab per format. */
export async function Hero({
  host,
  origin,
  stats,
  providers,
  showBrowse,
}: {
  host: string;
  /** Public origin of this instance, filled into the snippets. */
  origin: string;
  /** Public counts; omitted while anonymous view is off. */
  stats: PublicStats | null;
  providers: SocialProviderId[];
  showBrowse: boolean;
}) {
  const urls = clientUrls(origin, host);
  const formats: HighlightedFormat[] = await Promise.all(
    heroSamples(origin).map(async (sample, i) => ({
      format: sample.format,
      url: urls[i]!,
      files: await Promise.all(sample.snippets.map(async (s) => ({ file: s.file, html: await highlight(s.code, s.lang) }))),
    })),
  );

  return (
    <section
      aria-labelledby="hero-title"
      className="border-b bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-size-[32px_32px] bg-position-[-1px_-1px]"
    >
      <Container className="grid grid-cols-[minmax(0,1fr)] items-start gap-12 py-12 sm:py-16 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:py-[72px]">
        <div className="max-w-[620px] bg-background shadow-[0_0_0_18px_var(--background)] xl:max-w-none">
          <Eyebrow>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-release" />
            <span>{host}</span>
            {stats && (
              <>
                <span aria-hidden="true">·</span>
                <span>{plural(stats.artifacts, "artifact", "artifacts")}</span>
                <span aria-hidden="true">·</span>
                <span>{plural(stats.repositories, "repository", "repositories")}</span>
              </>
            )}
          </Eyebrow>
          <h1
            id="hero-title"
            className="mb-[18px] text-[34px] leading-[1.06] font-semibold tracking-[-0.035em] text-balance sm:text-[42px] xl:text-[46px] xl:leading-[1.04]"
          >
            One registry for Maven, npm, Docker and proto.
          </h1>
          <p className="mb-[26px] max-w-[50ch] text-base leading-[1.55] text-muted-foreground">
            Weaver hosts the packages and images you publish, mirrors Maven Central, npmjs and Docker Hub, and puts both
            behind one URL per format. Stock clients connect with a URL and a token, to a server you run.
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            <SignInButtons providers={providers} />
            {showBrowse && (
              <Button asChild size="lg" variant="outline" className="px-4">
                <Link href="/browse">Browse public repositories</Link>
              </Button>
            )}
            <Link
              href="/docs"
              className="ml-1.5 inline-flex items-center gap-1 rounded-sm text-sm text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Read the docs
              <span aria-hidden="true">→</span>
            </Link>
          </div>
          <ul className="mt-[26px] flex flex-wrap gap-x-[22px] gap-y-2 font-mono text-xs text-muted-foreground">
            <li>
              <b className="font-medium text-foreground">Invite only</b> · ask an admin
            </li>
            <li>
              <b className="font-medium text-foreground">Stock clients</b> · no plugins
            </li>
            <li>
              <b className="font-medium text-foreground">Self-hosted</b>
            </li>
          </ul>
        </div>
        <HeroCards formats={formats} />
      </Container>
    </section>
  );
}
