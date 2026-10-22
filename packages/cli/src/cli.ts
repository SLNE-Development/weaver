import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, resolveOutDir, resolveUrl, CliError } from "./config.js";
import { defaultCacheDir, fetchProtos } from "./fetch.js";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const HELP = `Usage: weaver <command> [options]

Commands:
  fetch    Download the configured proto dependencies into the output directory

Options for fetch:
  --config <file>   Config file (default: weaver.json)
  --out <dir>       Output directory (overrides outDir; default: protos)
  -h, --help        Show this help

Environment:
  WEAVER_URL     Registry url (overrides the config's url)
  WEAVER_TOKEN   API key sent as a Bearer token
`;

/** Runs the CLI and returns the process exit code; expected failures print only their message. */
export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io,
  cwd: string,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const command = positionals[0];
    if (values.help) {
      io.out(HELP);
      return 0;
    }
    if (command === undefined) {
      io.err(HELP);
      return 1;
    }
    if (command !== "fetch") throw new CliError(`Unknown command "${command}". Run weaver --help.`);

    const configPath = resolve(cwd, values.config ?? "weaver.json");
    const config = await loadConfig(configPath);
    const result = await fetchProtos({
      url: resolveUrl(config, env),
      token: env.WEAVER_TOKEN || undefined,
      repositories: config.repositories,
      dependencies: config.dependencies,
      outDir: resolveOutDir(config, values.out, cwd),
      cacheDir: defaultCacheDir(cwd),
      cwd,
      configPath,
      warn: (m) => io.err(`warning: ${m}\n`),
    });
    io.out(`Fetched ${result.files} file(s) from ${result.artifacts} artifact(s)\n`);
    return 0;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
