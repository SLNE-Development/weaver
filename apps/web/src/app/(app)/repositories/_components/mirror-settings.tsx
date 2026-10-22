"use client";

import type { ReactNode } from "react";
import { useWatch } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import type { Repo, UpstreamView } from "@weaver/core";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Badge } from "@weaver/ui/components/badge";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Textarea } from "@weaver/ui/components/textarea";
import { cn } from "@weaver/ui/lib/utils";
import {
  DEFAULT_STORE,
  RULE_SUBJECTS,
  mirrorSettingsSchema,
  toMirrorFormValues,
  toMirrorPatch,
  type MirrorSettingsValues,
} from "@/lib/repository-settings";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";
import { numberInputProps, SettingRow, SettingsForm, SwitchRow, useSettingsForm } from "../repository-form";
import { UpstreamsEditor } from "./upstreams-editor";

const STORE_LABELS: Record<string, string> = { local: "Local disk", s3: "S3" };

/** A labelled group of rows inside the mirror form. */
function Group({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid">
      <div className="flex items-center justify-between gap-2 bg-muted/30 px-4 py-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
        {trailing}
      </div>
      <div className="divide-y border-t">{children}</div>
    </div>
  );
}

function MirrorForm({
  repo,
  upstreams,
  stores,
  onSave,
  submitting,
}: {
  repo: Repo;
  upstreams: UpstreamView[];
  stores: string[];
  onSave: (patch: ReturnType<typeof toMirrorPatch>) => Promise<unknown>;
  submitting: boolean;
}) {
  const form = useSettingsForm(mirrorSettingsSchema, toMirrorFormValues(repo, upstreams));
  const caching = useWatch({ control: form.control, name: "cacheEnabled" });
  const docker = repo.format === "docker";

  return (
    <SettingsForm form={form} onSubmit={(values: MirrorSettingsValues) => onSave(toMirrorPatch(values, repo.format))} submitting={submitting}>
      <Group title="Upstreams">
        <p className="px-4 pt-3 text-xs text-muted-foreground">Tried from top to bottom until one answers.</p>
        <UpstreamsEditor form={form} format={repo.format} />
      </Group>

      <Group
        title="Cache"
        trailing={
          <Badge
            variant="outline"
            data-testid="cache-status"
            className={cn("font-mono text-[11px]", caching ? "border-release/40 bg-release-soft text-release" : "text-muted-foreground")}
          >
            {caching ? "Caching on" : "Caching off"}
          </Badge>
        }
      >
        <SwitchRow
          form={form}
          name="cacheEnabled"
          label="Cache upstream content"
          description="Off: every request is proxied to the upstream and nothing is stored. On: fetched files are stored and served from storage, and kept when the upstream is down."
        />
        {caching && (
          <>
            <FormField
              control={form.control}
              name="cacheStore"
              render={({ field }) => (
                <FormItem>
                  <SettingRow>
                    <div className="grid gap-1">
                      <FormLabel>Storage</FormLabel>
                      <FormDescription className="text-xs">Where cached files go. The default is set in admin Settings.</FormDescription>
                    </div>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-44" aria-label="Cache storage">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={DEFAULT_STORE}>Server default</SelectItem>
                        {stores.map((id) => (
                          <SelectItem key={id} value={id}>
                            {STORE_LABELS[id] ?? id}
                          </SelectItem>
                        ))}
                        {/* A store chosen earlier that this server no longer configures. */}
                        {field.value !== DEFAULT_STORE && !stores.includes(field.value) && (
                          <SelectItem value={field.value}>{`${STORE_LABELS[field.value] ?? field.value} (not configured)`}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </SettingRow>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="metadataTtlSeconds"
              render={({ field }) => (
                <FormItem>
                  <SettingRow>
                    <div className="grid gap-1">
                      <FormLabel>Metadata TTL (seconds)</FormLabel>
                      <FormDescription className="text-xs">
                        How long version lists and tags are served from the cache before they are checked upstream again.
                      </FormDescription>
                      <FormMessage />
                    </div>
                    <FormControl>
                      <Input {...numberInputProps(field)} min={0} step={1} className="w-28 font-mono tabular-nums" />
                    </FormControl>
                  </SettingRow>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="maxAgeDays"
              render={({ field }) => (
                <FormItem>
                  <SettingRow>
                    <div className="grid gap-1">
                      <FormLabel>Max age (days)</FormLabel>
                      <FormDescription className="text-xs">Cached files not downloaded for this long are evicted. Empty: unlimited.</FormDescription>
                      <FormMessage />
                    </div>
                    <FormControl>
                      <Input {...numberInputProps(field, true)} min={1} step={1} placeholder="unlimited" className="w-28 font-mono tabular-nums" />
                    </FormControl>
                  </SettingRow>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="maxSizeGib"
              render={({ field }) => (
                <FormItem>
                  <SettingRow>
                    <div className="grid gap-1">
                      <FormLabel>Max size (GiB)</FormLabel>
                      <FormDescription className="text-xs">
                        Beyond this size the least recently used files are evicted. Empty: unlimited.
                      </FormDescription>
                      <FormMessage />
                    </div>
                    <FormControl>
                      <Input {...numberInputProps(field, true)} min={0} step="any" placeholder="unlimited" className="w-28 font-mono tabular-nums" />
                    </FormControl>
                  </SettingRow>
                </FormItem>
              )}
            />
          </>
        )}
        <SwitchRow
          form={form}
          name="offline"
          label="Offline"
          description="Never contact the upstreams; serve only what is cached."
        />
      </Group>

      <Group title="Rules">
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          {(["allow", "deny"] as const).map((name) => (
            <FormField
              key={name}
              control={form.control}
              name={name}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{name === "allow" ? "Allow" : "Deny"}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} spellCheck={false} placeholder={name === "allow" ? "everything" : "nothing"} className="resize-y font-mono text-xs" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            One pattern per line: {RULE_SUBJECTS[repo.format]}. <code className="font-mono">*</code> matches anything. Deny wins;
            requests outside the rules are answered as not found without asking the upstream.
          </p>
        </div>
      </Group>

      {docker && (
        <Group title="Docker">
          <SwitchRow
            form={form}
            name="dockerHub"
            label="Docker Hub"
            description="The upstream is Docker Hub: nginx is looked up as library/nginx."
          />
          <SwitchRow
            form={form}
            name="dockerRoot"
            label="Root mirror"
            description="Serve image names that don't start with a repository name, so the daemon's registry-mirrors setting works. Only one mirror can be the root."
          />
        </Group>
      )}
    </SettingsForm>
  );
}

/** The settings of a mirror: ordered upstreams, cache, offline mode, allow/deny rules and, for Docker, the Docker Hub and root options. */
export function MirrorSettings({
  repo,
  onSave,
  submitting,
}: {
  repo: Repo;
  onSave: (patch: ReturnType<typeof toMirrorPatch>) => Promise<unknown>;
  submitting: boolean;
}) {
  const trpc = useTRPC();
  const upstreams = useQuery(trpc.repositories.upstreams.queryOptions({ name: repo.name }));
  const storage = useQuery(trpc.settings.storage.queryOptions());

  if (upstreams.isError || storage.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the mirror settings</AlertTitle>
        <AlertDescription>{errorMessage(upstreams.error ?? storage.error)}</AlertDescription>
      </Alert>
    );
  }
  if (upstreams.isPending || storage.isPending) return <Skeleton className="h-96 w-full" />;
  return <MirrorForm repo={repo} upstreams={upstreams.data} stores={storage.data.configured} onSave={onSave} submitting={submitting} />;
}
