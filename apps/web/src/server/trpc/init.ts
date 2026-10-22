import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";
import {
  getSettings,
  RegistryError,
  type ErrorCode,
  type Principal,
  type Registry,
  type RepoService,
  type ServerSettings,
  type StoreSet,
} from "@weaver/core";
import type { Db } from "@weaver/db";
import { QueueUnavailableError, type CleanupQueue } from "@weaver/jobs";
import type { Auth } from "../auth";
import { getServerContext } from "../context";
import { getCleanupQueue } from "../jobs";
import { getPrincipal } from "../principal";
import { env } from "@/env";

/** Everything a tRPC procedure can use. Built per request by {@link createTrpcContext}. */
export interface TrpcContext {
  db: Db;
  registry: Registry;
  /** The configured object stores. */
  stores: StoreSet;
  /** Repository management; every repository mutation goes through it. */
  repos: RepoService;
  auth: Auth;
  /** Who is calling: a signed-in user (session cookie), an API key, or anonymous. */
  principal: Principal;
  /** Server settings as stored when the request started. */
  settings: ServerSettings;
  /** The public base URL (`BETTER_AUTH_URL`) for absolute links such as invite URLs. */
  publicUrl: string;
  /** The producer queue for cleanup jobs, or `null` when `VALKEY_URL` is not configured. */
  cleanupQueue: () => CleanupQueue | null;
}

/** A user principal, as authed procedures see it. */
export type UserPrincipal = Extract<Principal, { kind: "user" }>;

/**
 * Builds the context for one request from its headers: resolves the principal (a banned user is
 * refused with `UNAUTHORIZED`) and loads the server settings.
 */
export async function createTrpcContext(
  opts: { headers: Headers },
  deps: Pick<TrpcContext, "db" | "registry" | "repos" | "auth" | "stores"> = getServerContext(),
): Promise<TrpcContext> {
  let principal: Principal;
  try {
    principal = await getPrincipal(new Request(env.BETTER_AUTH_URL, { headers: opts.headers }), deps);
  } catch (error) {
    if (error instanceof RegistryError) throw new TRPCError({ code: "UNAUTHORIZED", message: error.message, cause: error });
    throw error;
  }
  return {
    db: deps.db,
    registry: deps.registry,
    stores: deps.stores,
    repos: deps.repos,
    auth: deps.auth,
    principal,
    settings: await getSettings(deps.db, { primaryStore: deps.stores.primary.id, configuredStores: deps.stores.configured() }),
    publicUrl: env.BETTER_AUTH_URL,
    cleanupQueue: getCleanupQueue,
  };
}

const TRPC_CODE_BY_REGISTRY_CODE: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
  invalid_request: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  method_not_allowed: "METHOD_NOT_SUPPORTED",
  immutable: "CONFLICT",
  has_dependents: "CONFLICT",
  payload_too_large: "PAYLOAD_TOO_LARGE",
  validation_failed: "UNPROCESSABLE_CONTENT",
  upstream_unavailable: "INTERNAL_SERVER_ERROR",
};

/** Registry error code and details, carried to the client in `error.data.registry`. */
export interface RegistryErrorData {
  code: ErrorCode;
  details: unknown;
}

/** Message sent instead of the real one when a procedure fails unexpectedly. */
export const INTERNAL_ERROR_MESSAGE = "Something went wrong";

/** Whether `error` is an unexpected failure (a plain error, not a deliberate tRPC or registry error). */
function isUnexpected(error: TRPCError): boolean {
  const cause = error.cause;
  return (
    error.code === "INTERNAL_SERVER_ERROR" &&
    cause instanceof Error &&
    !(cause instanceof TRPCError) &&
    !(cause instanceof RegistryError)
  );
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  /**
   * Adds the registry code and details (`data.registry`) and zod field errors. Unexpected failures
   * are logged here, server-side, and reach the client only as {@link INTERNAL_ERROR_MESSAGE}
   * without a stack, so internals (SQL, hosts, paths) never leak.
   */
  errorFormatter({ shape, error, path }) {
    const registry: RegistryErrorData | null =
      error.cause instanceof RegistryError ? { code: error.cause.code, details: error.cause.details ?? null } : null;
    if (isUnexpected(error)) {
      console.error(`weaver: tRPC ${path ?? "?"} failed`, error.cause);
      const data = { ...shape.data };
      delete data.stack;
      return { ...shape, message: INTERNAL_ERROR_MESSAGE, data: { ...data, registry: null, zodError: null } };
    }
    return {
      ...shape,
      data: {
        ...shape.data,
        registry,
        zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;

/** Turns domain errors thrown by procedures into tRPC errors with a matching code. */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof RegistryError) {
      throw new TRPCError({ code: TRPC_CODE_BY_REGISTRY_CODE[cause.code], message: cause.message, cause });
    }
    if (cause instanceof QueueUnavailableError) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `${cause.message}; try again later`, cause });
    }
  }
  return result;
});

/** Any caller, signed in or not. */
export const publicProcedure = t.procedure.use(domainErrors);

/**
 * Browsing: anonymous callers only while the "Allow anonymous view" setting is on (they then see
 * public repositories only, which the routers enforce through the principal); otherwise `UNAUTHORIZED`.
 */
export const browseProcedure = publicProcedure.use(({ ctx, next }) => {
  if (ctx.principal.kind === "anonymous" && !ctx.settings.anonymousView) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to browse this Weaver" });
  }
  return next();
});

/** A signed-in user (session). API keys and anonymous callers get `UNAUTHORIZED`. */
export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  const principal = ctx.principal;
  if (principal.kind !== "user") throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first" });
  return next({ ctx: { principal } });
});

/** A signed-in maintainer or admin; viewers get `FORBIDDEN`. */
export const maintainerProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.role === "viewer") throw new TRPCError({ code: "FORBIDDEN", message: "Maintainers and admins only" });
  return next();
});

/** A signed-in admin; everyone else gets `FORBIDDEN`. */
export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
  return next();
});
