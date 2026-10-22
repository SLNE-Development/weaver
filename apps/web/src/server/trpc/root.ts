import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createCallerFactory, router } from "./init";
import { auditRouter } from "./routers/audit";
import { browseRouter } from "./routers/browse";
import { dashboardRouter } from "./routers/dashboard";
import { dockerRouter } from "./routers/docker";
import { invitesRouter } from "./routers/invites";
import { keysRouter } from "./routers/keys";
import { mavenRouter } from "./routers/maven";
import { npmRouter } from "./routers/npm";
import { policiesRouter } from "./routers/policies";
import { repositoriesRouter } from "./routers/repositories";
import { searchRouter } from "./routers/search";
import { settingsRouter } from "./routers/settings";
import { statsRouter } from "./routers/stats";
import { usersRouter } from "./routers/users";
import { versionsRouter } from "./routers/versions";

/** The tRPC API of the management UI. */
export const appRouter = router({
  browse: browseRouter,
  search: searchRouter,
  dashboard: dashboardRouter,
  docker: dockerRouter,
  maven: mavenRouter,
  npm: npmRouter,
  repositories: repositoriesRouter,
  policies: policiesRouter,
  versions: versionsRouter,
  keys: keysRouter,
  invites: invitesRouter,
  users: usersRouter,
  settings: settingsRouter,
  stats: statsRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;

/** Input types of every procedure, e.g. `RouterInputs["keys"]["create"]`. */
export type RouterInputs = inferRouterInputs<AppRouter>;

/** Output types of every procedure, e.g. `RouterOutputs["browse"]["version"]`. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Creates a server-side caller for a given context (RSC and tests). */
export const createCaller = createCallerFactory(appRouter);
