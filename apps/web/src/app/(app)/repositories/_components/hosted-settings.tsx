"use client";

import type { DockerHostedConfig, MavenHostedConfig, ProtoHostedConfig, Repo } from "@weaver/core";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@weaver/ui/components/form";
import { Input } from "@weaver/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { dockerHostedSchema, mavenHostedSchema, protoHostedSchema } from "@/lib/repository-settings";
import { numberInputProps, SettingRow, SettingsForm, SwitchRow, useSettingsForm } from "../repository-form";

/** Saves a config patch of the repository; rejects when the save fails (the caller reports it). */
type SaveConfig = (config: object) => Promise<unknown>;

const VERSION_POLICIES = [
  { value: "mixed", label: "Releases and snapshots" },
  { value: "release", label: "Releases only" },
  { value: "snapshot", label: "Snapshots only" },
] as const;

function MavenSettings({ config, onSave, submitting }: { config: MavenHostedConfig; onSave: SaveConfig; submitting: boolean }) {
  const form = useSettingsForm(mavenHostedSchema, config);
  return (
    <SettingsForm form={form} onSubmit={onSave} submitting={submitting}>
      <FormField
        control={form.control}
        name="versionPolicy"
        render={({ field }) => (
          <FormItem>
            <SettingRow>
              <div className="grid gap-1">
                <FormLabel>Versions</FormLabel>
                <FormDescription className="text-xs">Which versions a deploy may add. Snapshot versions end in -SNAPSHOT.</FormDescription>
              </div>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="w-56" aria-label="Versions">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {VERSION_POLICIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </FormItem>
        )}
      />
      <SwitchRow
        form={form}
        name="redeploy"
        label="Allow redeploy"
        description="Lets a deploy overwrite a released version. Snapshots can always be overwritten."
      />
    </SettingsForm>
  );
}

function DockerSettings({ config, onSave, submitting }: { config: DockerHostedConfig; onSave: SaveConfig; submitting: boolean }) {
  const form = useSettingsForm(dockerHostedSchema, config);
  return (
    <SettingsForm form={form} onSubmit={onSave} submitting={submitting}>
      <SwitchRow
        form={form}
        name="tagImmutable"
        label="Immutable tags"
        description="A pushed tag can't be moved to another image. Pushing the same image again is still fine."
      />
    </SettingsForm>
  );
}

function ProtoSettings({ config, onSave, submitting }: { config: ProtoHostedConfig; onSave: SaveConfig; submitting: boolean }) {
  const form = useSettingsForm(protoHostedSchema, config);
  return (
    <SettingsForm form={form} onSubmit={onSave} submitting={submitting}>
      <SwitchRow form={form} name="allowReleases" label="Accept releases" description="Versions without the -SNAPSHOT suffix, e.g. 1.4.0." />
      <SwitchRow
        form={form}
        name="allowSnapshots"
        label="Accept snapshots"
        description="-SNAPSHOT versions, e.g. 1.5.0-SNAPSHOT. Every publish adds a new build."
      />
      <SwitchRow
        form={form}
        name="allowRedeploy"
        label="Allow redeploy"
        description="Lets a publish replace an existing release version. Off by default: a published release is immutable. Snapshots are not affected, and versions other artifacts depend on still can't be replaced."
      />
      <FormField
        control={form.control}
        name="resolutionPriority"
        render={({ field }) => (
          <FormItem>
            <SettingRow>
              <div className="grid gap-1">
                <FormLabel>Resolution priority</FormLabel>
                <FormDescription className="text-xs">
                  Lower wins. When a dependency exists in several repositories, it is resolved from the repository with the lowest number.
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
    </SettingsForm>
  );
}

/**
 * The format-specific settings of a hosted repository; `onSave` gets a config patch. npm has none:
 * a published npm version can never be overwritten.
 */
export function HostedSettings({ repo, onSave, submitting }: { repo: Repo; onSave: SaveConfig; submitting: boolean }) {
  switch (repo.format) {
    case "maven":
      return <MavenSettings config={repo.config as MavenHostedConfig} onSave={onSave} submitting={submitting} />;
    case "docker":
      return <DockerSettings config={repo.config as DockerHostedConfig} onSave={onSave} submitting={submitting} />;
    case "proto":
      return <ProtoSettings config={repo.config as ProtoHostedConfig} onSave={onSave} submitting={submitting} />;
    case "npm":
      return (
        <p className="rounded-md border px-4 py-3 text-sm text-muted-foreground">
          Nothing to set: like the public registry, a published npm version can never be overwritten.
        </p>
      );
  }
}
