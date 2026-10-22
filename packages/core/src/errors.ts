export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "immutable"
  | "has_dependents"
  | "payload_too_large"
  | "validation_failed"
  | "upstream_unavailable";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  immutable: 409,
  has_dependents: 409,
  payload_too_large: 413,
  validation_failed: 422,
  upstream_unavailable: 502,
};

/** Process-wide brand of {@link RegistryError} instances, shared by every copy of this module. */
const BRAND = Symbol.for("weaver.RegistryError");

/**
 * Domain error carrying a stable machine-readable code and its HTTP status.
 *
 * `instanceof RegistryError` checks a process-wide brand instead of the prototype chain: Next.js
 * bundles this package separately per entry point (instrumentation, route handlers), and the
 * shared server context hands out a registry from one bundle to code from another.
 */
export class RegistryError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
  }

  readonly [BRAND] = true;
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}
