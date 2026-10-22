// Applies pending drizzle migrations. Lives next to @weaver/db's dist/ and drizzle/ (see Dockerfile).
import { createDb, migrate } from "./dist/index.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(1);
}

const db = createDb(url);
try {
  await migrate(db);
  console.log("migrate: database is up to date");
} catch (err) {
  console.error("migrate: failed", err);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
