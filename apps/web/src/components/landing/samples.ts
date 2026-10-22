/**
 * Client snippets and sample content of the landing page. The snippets follow the client docs in
 * content/docs (maven.md, npm.md, docker.md, gradle.md, cli.md) and are filled in with this
 * instance's URL.
 */

/** Sample proto artifact shown in the browse preview. */
export const SAMPLE_COORDINATE = "dev.surf.economy:economy-contracts:1.4.0";

export const PROTO_FILES = [
  {
    path: "surf/economy/v1/money.proto",
    code: `syntax = "proto3";
package surf.economy.v1;

// An amount in the smallest unit of a currency.
message Money {
  string currency_code = 1;
  int64 amount_minor = 2;
}
`,
  },
  { path: "surf/economy/v1/events.proto" },
  { path: "surf/economy/v1/service.proto" },
] as const;

/** The instance's host without the scheme, as docker and `.npmrc` auth lines use it. */
function hostOf(origin: string): string {
  return new URL(origin).host;
}

/** Languages the snippets are highlighted as; see ./highlight. */
export type SnippetLang = "kotlin" | "ini" | "shellscript" | "json" | "xml" | "yaml";

export interface Snippet {
  /** File name, or a short label such as "terminal". */
  file: string;
  lang: SnippetLang;
  code: string;
}

export interface FormatSample {
  /** Tab label. */
  format: string;
  snippets: Snippet[];
}

/** The hero's tabs: one way in per format, filled in with this instance's URL. */
export function heroSamples(origin: string): FormatSample[] {
  const host = hostOf(origin);
  return [
    {
      format: "Maven",
      snippets: [
        {
          file: "build.gradle.kts",
          lang: "kotlin",
          code: `repositories {
    maven("${origin}/maven/releases/") {
        name = "weaverReleases"
        credentials(PasswordCredentials::class)
    }
}

dependencies {
    implementation("org.example:lib:1.0")
}
`,
        },
      ],
    },
    {
      format: "npm",
      snippets: [
        {
          file: ".npmrc",
          lang: "ini",
          code: `registry=${origin}/npm/npm-group/
//${host}/npm/npm-group/:_authToken=\${WEAVER_TOKEN}
`,
        },
        {
          file: "or sign in from the browser",
          lang: "shellscript",
          code: `npm login --registry=${origin}/npm/npm-group/
`,
        },
      ],
    },
    {
      format: "Docker",
      snippets: [
        {
          file: "terminal",
          lang: "shellscript",
          code: `echo "$WEAVER_TOKEN" | docker login ${host} \\
    --username token --password-stdin
docker push ${host}/apps/web:1.0
docker pull ${host}/hub/nginx:latest
`,
        },
      ],
    },
    {
      format: "proto",
      snippets: [
        {
          file: "build.gradle.kts",
          lang: "kotlin",
          code: `plugins {
    id("dev.slne.weaver") version "0.1.0"
}

weaver {
    repositories("releases", "snapshots")
}

dependencies {
    weaver("${SAMPLE_COORDINATE}")
}
`,
        },
      ],
    },
  ];
}

/** settings.xml excerpt that sends every Maven request through one group. */
export function mavenGroupSettings(origin: string): string {
  return `<mirrors>
  <mirror>
    <id>weaver-all</id>
    <mirrorOf>*</mirrorOf>
    <url>${origin}/maven/all/</url>
  </mirror>
</mirrors>
`;
}

/** Publishing, tagging and deprecating on a hosted npm repository. */
export function npmPublish(origin: string): string {
  return `npm publish --registry=${origin}/npm/releases/
npm dist-tag add my-package@1.2.0 next
npm deprecate my-package@1.1.0 "use 1.2.0"
`;
}

/** daemon.json that makes Weaver's root mirror the Docker daemon's pull-through mirror. */
export function dockerDaemonJson(origin: string): string {
  return `{
  "registry-mirrors": ["https://${hostOf(origin)}"]
}
`;
}

/** weaver.json of the Node CLI, pointing at this instance. */
export function cliConfig(origin: string): string {
  return `{
  "url": "${origin}",
  "repositories": ["releases"],
  "dependencies": ["${SAMPLE_COORDINATE}"],
  "outDir": "./protos"
}
`;
}

/** Compose excerpt for the self-hosting section, with this instance's public URL. */
export function composeSnippet(origin: string): string {
  return `services:
  weaver:
    image: ghcr.io/slne-development/weaver:latest
    command: ["web"]
    environment:
      BETTER_AUTH_URL: ${origin}
      INITIAL_ADMIN: github:your-login
      STORAGE_DRIVER: s3
  worker:
    image: ghcr.io/slne-development/weaver:latest
    command: ["worker"]
`;
}
