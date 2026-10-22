import { RegistryError } from "@weaver/core";

/** Body of every REST error response. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** A JSON response with the given status. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The REST error response for a registry error: its status, code, message and details. */
export function errorResponse(error: RegistryError): Response {
  const body: ErrorBody = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return json(body, error.status);
}

/**
 * Wraps a route handler: a thrown {@link RegistryError} becomes its REST error response, and any
 * other error is logged and answered with a generic 500 that reveals nothing about its cause.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      console.error("weaver: unhandled error in API route", error);
      const body: ErrorBody = { error: { code: "internal_error", message: "Internal server error" } };
      return json(body, 500);
    }
  };
}
