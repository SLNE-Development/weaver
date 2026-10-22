import { z } from "zod";
import { CliError } from "./config.js";

const resolveSchema = z.object({
  artifacts: z.array(
    z.object({
      repository: z.string(),
      coordinate: z.string(),
      group: z.string(),
      name: z.string(),
      version: z.string(),
      buildNumber: z.number(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      archiveUrl: z.string().min(1),
    }),
  ),
  conflicts: z.array(
    z.object({
      group: z.string(),
      name: z.string(),
      requested: z.array(z.string()),
      selected: z.string(),
    }),
  ),
});

/** Validated `/api/v1/resolve` response. */
export type ResolveResponse = z.infer<typeof resolveSchema>;
export type ResolvedArtifact = ResolveResponse["artifacts"][number];
export type ResolveConflict = ResolveResponse["conflicts"][number];

const DEFAULT_TIMEOUT_MS = 60_000;

export interface Downloaded {
  data: Buffer;
  /** Value of `x-weaver-sha256`, when the server sent it. */
  sha256?: string;
}

/** Minimal client for the registry REST API. */
export class RegistryClient {
  private readonly base: URL;

  constructor(
    url: string,
    private readonly token?: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.base = new URL(url);
  }

  /**
   * Maps an archive URL from the server onto the configured registry. The bearer
   * token is only ever sent to the configured scheme+host+port, so a foreign
   * origin (a misconfigured or malicious server) has its path rebased onto the
   * configured url instead of being contacted. The query (the pinned `?build=`)
   * is kept either way.
   */
  archiveTarget(archiveUrl: string): URL {
    const given = new URL(archiveUrl, this.base);
    if (given.origin === this.base.origin) return given;
    const prefix = this.base.pathname.replace(/\/+$/, "");
    return new URL(`${prefix}${given.pathname}${given.search}`, this.base.origin);
  }

  async resolve(repositories: string[], dependencies: string[]): Promise<ResolveResponse> {
    const res = await this.request(new URL(`${this.base.pathname.replace(/\/+$/, "")}/api/v1/resolve`, this.base.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositories, dependencies }),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CliError("Malformed response from registry: resolve body is not valid JSON");
    }
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CliError(
        `Malformed response from registry: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`,
      );
    }
    return parsed.data;
  }

  async download(archiveUrl: string): Promise<Downloaded> {
    const res = await this.request(this.archiveTarget(archiveUrl), { method: "GET" });
    return {
      data: Buffer.from(await res.arrayBuffer()),
      sha256: res.headers.get("x-weaver-sha256")?.toLowerCase() ?? undefined,
    };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new CliError(`Request to ${url.origin} timed out after ${this.timeoutMs / 1000}s`);
      }
      const reason = err instanceof Error && err.cause instanceof Error ? err.cause.message : (err as Error).message;
      throw new CliError(`Cannot reach ${url.origin}: ${reason}`);
    }
    if (!res.ok) throw new CliError(await errorMessage(res));
    return res;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // fall through to the generic message
  }
  return `Registry responded with HTTP ${res.status}`;
}
