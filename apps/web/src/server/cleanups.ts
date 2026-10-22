import { protoCleanup, type CleanupRegistry } from "@weaver/core";
import { dockerCleanup } from "@weaver/docker";
import { mavenCleanup } from "@weaver/maven";
import { npmCleanup } from "@weaver/npm";

/** The format cleanups the web server previews with, by format. */
export function cleanupRegistry(): CleanupRegistry {
  return { proto: protoCleanup, maven: mavenCleanup, npm: npmCleanup, docker: dockerCleanup };
}
