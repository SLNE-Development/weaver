import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FormatHandler } from "@weaver/core";

/** One request a {@link HandlerUpstream} received. */
export interface UpstreamHit {
  method: string;
  /** The request target as sent, path and query, still percent-encoded. */
  url: string;
  headers: IncomingHttpHeaders;
}

/** A `FormatHandler` served on a local `node:http` port, standing in for a remote Weaver instance in tests. */
export interface HandlerUpstream {
  /** `http://127.0.0.1:<port>` without a trailing slash. */
  origin: string;
  /** Every request received, in order. */
  hits: UpstreamHit[];
  /** The handler answering requests below the mount; replace it freely during a test. */
  handler: FormatHandler;
  close(): Promise<void>;
}

/** Converts a `node:http` request to a fetch `Request`, streaming its body for methods that have one. */
function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`${origin}${req.url ?? "/"}`, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

/** Writes a fetch `Response` to a `node:http` response, streaming its body. */
async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>)
      .on("error", reject)
      .pipe(res)
      .on("finish", resolve)
      .on("error", reject);
  });
}

/**
 * Serves `handler` on a free local port below `mount` (e.g. `/api/v1/`): a request for
 * `<mount><rest>` calls `handler(request, rest)` with `rest` still percent-encoded and without the
 * query; anything outside the mount answers 404. Records every request in `hits`.
 */
export async function serveFormatHandler(handler: FormatHandler, mount = "/api/v1/"): Promise<HandlerUpstream> {
  let origin = "";
  const upstream: HandlerUpstream = {
    origin: "",
    hits: [],
    handler,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    upstream.hits.push({ method: req.method ?? "GET", url, headers: req.headers });
    const pathname = url.split("?")[0]!;
    if (!pathname.startsWith(mount)) {
      res.writeHead(404).end();
      return;
    }
    upstream
      .handler(toRequest(req, origin), pathname.slice(mount.length))
      .then((response) => writeResponse(response, res))
      .catch((error: unknown) => {
        // A body that fails after the headers went out breaks the connection off, as a crashed upstream would.
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        res.writeHead(500);
        res.end(String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  upstream.origin = origin;
  return upstream;
}
