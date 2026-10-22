"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { StoreId } from "@weaver/core";
import { Card, CardDescription, CardHeader, CardTitle } from "@weaver/ui/components/card";
import { Label } from "@weaver/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Spinner } from "@weaver/ui/components/spinner";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";

const STORE_LABELS: Record<StoreId, string> = { local: "Local disk", s3: "S3" };

/**
 * The "Default cache storage" select: where mirrors that don't pick a store keep cached files.
 * Only stores configured on this server (by env) are offered; hosted content always uses `primary`.
 */
export function DefaultCacheStorageSetting({
  initial,
  primary,
  configured,
}: {
  initial: StoreId;
  primary: StoreId;
  configured: StoreId[];
}) {
  const trpc = useTRPC();
  const [store, setStore] = useState(initial);
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (settings) => {
        setStore(settings.defaultCacheStore);
        toast.success(`Mirrors now cache to ${STORE_LABELS[settings.defaultCacheStore]} by default`);
      },
      onError: (error) => toast.error("Couldn't change the setting", { description: errorMessage(error) }),
    }),
  );

  return (
    <Card className="gap-4 rounded-md py-4 shadow-none">
      <CardHeader className="px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="grid gap-1.5">
            <CardTitle className="text-sm">
              <Label htmlFor="default-cache-storage">Default cache storage</Label>
            </CardTitle>
            <CardDescription>
              Where mirrors keep cached files unless they choose a store themselves. Hosted content always goes to the primary store (
              {STORE_LABELS[primary]}). Stores are configured by environment variables.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {update.isPending && <Spinner className="text-muted-foreground" />}
            <Select
              value={store}
              disabled={update.isPending || configured.length < 2}
              onValueChange={(value) => update.mutate({ defaultCacheStore: value as StoreId })}
            >
              <SelectTrigger id="default-cache-storage" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {configured.map((id) => (
                  <SelectItem key={id} value={id}>
                    {STORE_LABELS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}
