import { mountRoute } from "@/server/formats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every method of the proto REST API goes to its format handler, which routes on the raw path.
 * HEAD is exported explicitly so Next.js does not answer it by running GET (which counts a download).
 */
const handler = mountRoute("proto");
export const GET = handler;
export const HEAD = handler;
export const PUT = handler;
export const POST = handler;
export const DELETE = handler;
