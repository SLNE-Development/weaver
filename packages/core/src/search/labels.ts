import type { Format } from "../repos/config.js";

/**
 * The name a package is known by in its format: `org.apache.commons:commons-lang3` (maven, proto),
 * `@scope/name` or `name` (npm; the scope is stored with or without its `@`), `team/app` (docker).
 */
export function componentLabel(format: Format, namespace: string, name: string): string {
  if (namespace === "") return name;
  switch (format) {
    case "maven":
    case "proto":
      return `${namespace}:${name}`;
    case "npm":
      return `${namespace.startsWith("@") ? namespace : `@${namespace}`}/${name}`;
    case "docker":
      return `${namespace}/${name}`;
  }
}
