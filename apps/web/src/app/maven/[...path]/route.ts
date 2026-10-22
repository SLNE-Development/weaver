import { mountRoute } from "@/server/formats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every method of the maven mount goes to the format handler. */
const handler = mountRoute("maven");
export const GET = handler;
export const HEAD = handler;
export const PUT = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
