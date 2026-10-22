"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@weaver/ui/components/select";
import { RANGE_OPTIONS, type RangeDays } from "@/lib/stats";

/** Picks how many days of history a stats page shows; the choice lives in the `?days=` query parameter. */
export function RangeSelect({ days }: { days: RangeDays }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function choose(value: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("days", value);
    // A different range restarts any paging.
    next.delete("before");
    router.replace(`${pathname}?${next.toString()}`);
  }

  return (
    <Select value={String(days)} onValueChange={choose}>
      <SelectTrigger size="sm" className="w-32" aria-label="Time range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGE_OPTIONS.map((option) => (
          <SelectItem key={option.days} value={String(option.days)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
