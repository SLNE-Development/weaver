import type { FormatDeps, Principal } from "@weaver/core";

/** What every Maven request reader and writer needs: the shared dependencies, who asks, and the method. */
export interface MavenContext {
  deps: FormatDeps;
  principal: Principal;
  method: "GET" | "HEAD" | "PUT";
}
