/**
 * Repository and group name rules for client-side form validation. They mirror
 * `isValidRepositoryName` / `isValidGroup` of `@weaver/core`, which can't be bundled into the
 * browser; `names.test.ts` checks both agree. The server validates again on every call.
 */

const REPOSITORY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const GROUP_RE = /^[a-z0-9_]+(\.[a-z0-9_-]+)*$/;

/** Lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters. */
export function isValidRepositoryName(name: string): boolean {
  return REPOSITORY_RE.test(name);
}

/** A group (or group prefix) such as `com.acme.orders`. */
export function isValidGroupPrefix(prefix: string): boolean {
  return GROUP_RE.test(prefix);
}

/** Hint shown under repository name inputs. */
export const REPOSITORY_NAME_HINT = "Lowercase letters, digits and dashes; starts with a letter or digit; at most 63 characters.";

/** Hint shown under group prefix inputs. */
export const GROUP_PREFIX_HINT = "Matches the group itself and every group below it, e.g. com.acme covers com.acme.orders.";
