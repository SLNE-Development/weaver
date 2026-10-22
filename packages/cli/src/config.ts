import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

/** Failure caused by user input or the server; printed without a stack trace. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export const configSchema = z.object({
  url: z.url().optional(),
  repositories: z.array(z.string().min(1)),
  dependencies: z.array(z.string().min(1)),
  outDir: z.string().min(1).optional(),
});

export type WeaverConfig = z.infer<typeof configSchema>;

/** Reads and validates the JSON config file. */
export async function loadConfig(path: string): Promise<WeaverConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(`Cannot read config file ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CliError(`Config file ${path} is not valid JSON`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new CliError(`Invalid config ${path}: ${issues}`);
  }
  return parsed.data;
}

/** Registry base URL: `WEAVER_URL` wins over the config's `url`; one of them is required. */
export function resolveUrl(config: WeaverConfig, env: Record<string, string | undefined>): string {
  const url = env.WEAVER_URL || config.url;
  if (!url) {
    throw new CliError("No registry url: set WEAVER_URL or `url` in the config file");
  }
  try {
    new URL(url);
  } catch {
    throw new CliError(`Invalid registry url: ${url}`);
  }
  return url;
}

/** Absolute output directory: `--out` wins over the config's `outDir`, default `protos`. */
export function resolveOutDir(config: WeaverConfig, flag: string | undefined, cwd: string): string {
  return resolve(cwd, flag ?? config.outDir ?? "protos");
}
