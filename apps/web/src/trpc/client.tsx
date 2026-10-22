"use client";

import { useState, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import superjson from "superjson";
import type { AppRouter } from "@/server/trpc/root";
import { makeQueryClient } from "./query-client";

export type { RouterInputs, RouterOutputs } from "@/server/trpc/root";

/**
 * `useTRPC()` returns the typed options proxy for TanStack Query, for example
 * `useQuery(trpc.search.query.queryOptions({ q }))` or
 * `useMutation(trpc.keys.create.mutationOptions())`.
 */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

let browserQueryClient: QueryClient | undefined;

/** One QueryClient per server request, but a single one in the browser across renders. */
function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/** Provides TanStack Query and the tRPC client (same-origin `/api/trpc`, session cookie) to the app. */
export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
