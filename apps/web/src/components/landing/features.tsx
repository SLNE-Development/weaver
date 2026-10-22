import { Container } from "./layout";

const FEATURES = [
  {
    icon: "ttl",
    title: "Mirror caching, when you want it",
    text: "Off by default, so a mirror stores nothing. Turn it on per mirror for a metadata TTL, eviction by age and size, and builds that keep working while the upstream is down.",
  },
  {
    icon: "key",
    title: "Tokens per repository",
    text: "Sign in to the web app with GitHub or Discord. Builds use access tokens with read or write per repository, never stronger than their owner's role.",
  },
  {
    icon: "@",
    title: "Anonymous read, if you choose",
    text: "Public repositories can be read without a token. Private ones need one, and reading a group covers everything served through it.",
  },
  {
    icon: "⌫",
    title: "Cleanup policies",
    text: "Expire old snapshot builds, unused versions, tags and untagged manifests, with a preview first. Docker layers are garbage-collected daily.",
  },
  {
    icon: "⌕",
    title: "Search and stats",
    text: "Search across every repository, browse each format in its own view, and see usage per repository.",
  },
  {
    icon: "s3",
    title: "Local disk or S3",
    text: "Hosted content on the primary store, mirror caches on either. Large Docker layers are streamed to S3.",
  },
];

/** Six features in a hairline grid: three columns on desktop, two on tablets, one on phones. */
export function Features() {
  return (
    <section aria-labelledby="features-title" className="border-b">
      <h2 id="features-title" className="sr-only">
        Features
      </h2>
      <Container className="px-0 sm:px-0 lg:px-0">
        {/* 1px gaps over the border colour draw the hairlines between cells. */}
        <ul className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-3 min-[1200px]:border-x">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="grid content-start gap-1.5 bg-background px-4 py-[22px] sm:px-[22px]">
              <span
                aria-hidden="true"
                className="mb-1.5 grid size-7 place-items-center rounded-md border font-mono text-[11px] font-semibold"
              >
                {feature.icon}
              </span>
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">{feature.text}</p>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
