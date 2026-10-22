import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A local HTTP server standing in for a Maven upstream in tests. */
export interface StubUpstream {
  /** Base URL with a trailing slash. */
  url: string;
  /** Served files by path without a leading slash; edit freely during a test. */
  files: Map<string, string | Buffer>;
  /** Every request path received, in order, with a leading slash. */
  hits: string[];
  /** While true every request answers 503. */
  down: boolean;
  /** Paths (without a leading slash) that answer this status with an empty body instead of their file. */
  statuses: Map<string, number>;
  close(): Promise<void>;
}

/** Starts a stub upstream on a free local port serving `files`. */
export async function startStubUpstream(files: Record<string, string | Buffer> = {}): Promise<StubUpstream> {
  const stub = { files: new Map(Object.entries(files)), hits: [] as string[], down: false, statuses: new Map<string, number>() };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    stub.hits.push(path);
    if (stub.down) {
      res.writeHead(503).end("down");
      return;
    }
    let key: string;
    try {
      key = decodeURIComponent(path.slice(1));
    } catch {
      res.writeHead(400).end("bad path");
      return;
    }
    const status = stub.statuses.get(key);
    if (status !== undefined) {
      res.writeHead(status, status === 401 ? { "www-authenticate": 'Basic realm="upstream"' } : {}).end();
      return;
    }
    const body = stub.files.get(key);
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    res.writeHead(200, { "content-length": buf.length });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(stub, {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
