/**
 * Runs once when the Next.js server starts. On the Node.js runtime it applies pending database
 * migrations before any request is served. `NEXT_RUNTIME` is set by Next.js itself, not by the
 * operator, so it is read directly instead of through `env`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ migrate }, { getServerContext }] = await Promise.all([import("@weaver/db"), import("./server/context")]);
  await migrate(getServerContext().db);
}
