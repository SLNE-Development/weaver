"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import type { Repo } from "@weaver/core";
import { Alert, AlertDescription, AlertTitle } from "@weaver/ui/components/alert";
import { Button } from "@weaver/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { Skeleton } from "@weaver/ui/components/skeleton";
import { Spinner } from "@weaver/ui/components/spinner";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";
import { KindLabel } from "./format-badge";

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * The ordered members of a group: the first member that has a requested item wins. Members are
 * hosted and mirror repositories of the group's format; `onSave` gets the new list of names.
 */
export function MembersEditor({
  repo,
  onSave,
  submitting,
}: {
  repo: Repo;
  onSave: (members: string[]) => Promise<unknown>;
  submitting: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const members = useQuery(trpc.repositories.members.queryOptions({ name: repo.name }));
  const candidates = useQuery(trpc.repositories.candidates.queryOptions({ format: repo.format }));
  const [draft, setDraft] = useState<string[] | null>(null);

  // Until the user edits the list (`draft`), it follows the server's members.
  const saved = members.data?.map((m) => m.name);

  if (members.isError || candidates.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn&apos;t load the members</AlertTitle>
        <AlertDescription>{errorMessage(members.error ?? candidates.error)}</AlertDescription>
      </Alert>
    );
  }
  if (members.isPending || candidates.isPending) return <Skeleton className="h-40 w-full" />;

  const list = draft ?? saved ?? [];
  const kindOf = new Map(candidates.data.map((c) => [c.name, c.kind]));
  const available = candidates.data.filter((c) => !list.includes(c.name));
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  async function save() {
    try {
      await onSave(list);
      // Show the saved order right away instead of the old one until the refetch lands.
      const byName = new Map([...candidates.data!, ...members.data!].map((r) => [r.name, r]));
      queryClient.setQueryData(
        trpc.repositories.members.queryKey({ name: repo.name }),
        list.flatMap((name) => byName.get(name) ?? []),
      );
      setDraft(null);
    } catch {
      // The caller reports the error; keep the draft.
    }
  }

  return (
    <div className="rounded-md border">
      {list.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">No members yet. A group without members serves nothing.</p>
      ) : (
        <ol className="divide-y">
          {list.map((name, index) => (
            <li key={name} data-testid="member-row" className="flex items-center gap-3 px-4 py-2">
              <span className="w-5 text-right font-mono text-xs text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{name}</span>
              {kindOf.has(name) && <KindLabel kind={kindOf.get(name)!} />}
              <div className="flex">
                <Button variant="ghost" size="icon" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => setDraft(move(list, index, index - 1))}>
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${name} down`}
                  disabled={index === list.length - 1}
                  onClick={() => setDraft(move(list, index, index + 1))}
                >
                  <ArrowDownIcon />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={() => setDraft(list.filter((n) => n !== name))}>
                  <XIcon />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-col gap-2 border-t bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Select value="" onValueChange={(name) => setDraft([...list, name])} disabled={available.length === 0}>
          <SelectTrigger className="w-full sm:w-64" aria-label="Add member">
            <SelectValue placeholder={available.length === 0 ? "No more repositories to add" : "Add member"} />
          </SelectTrigger>
          <SelectContent>
            {available.map((c) => (
              <SelectItem key={c.name} value={c.name} className="font-mono">
                <span className="truncate">{c.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" disabled={!dirty || submitting} onClick={save}>
          {submitting && <Spinner />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
