"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@weaver/ui/components/input-group";
import { cn } from "@weaver/ui/lib/utils";
import { searchHref } from "@/lib/search";

/** The search page's package search box, kept in step with `?q=`: Enter opens `/search?q=` with the typed text. */
export function SearchBox({ className }: { className?: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get("q") ?? "";
  const [value, setValue] = useState(q);
  // Follow the URL: a new `?q=` (back, forward, a link) replaces what the box shows.
  const [shown, setShown] = useState(q);
  if (shown !== q) {
    setShown(q);
    setValue(q);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    if (q.length > 0) router.push(searchHref(q));
  }

  return (
    <form role="search" onSubmit={onSubmit} className={cn("w-full max-w-sm", className)}>
      <InputGroup className="h-8">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label="Search packages"
          placeholder="Search packages"
          value={value}
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
        />
      </InputGroup>
    </form>
  );
}
