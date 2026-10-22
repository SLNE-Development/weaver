"use client";

import { useEffect, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  KeyRoundIcon,
  LogInIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import type { Role } from "@weaver/core";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@weaver/ui/components/command";
import { navItemsFor } from "@/lib/navigation";
import { useCommandMenu } from "./command-actions";
import { NAV_ICONS } from "./nav-icons";
import { useSignOut } from "./use-sign-out";

/** Props of the slot that renders live package results for the typed query. */
export interface PackageSearchProps {
  query: string;
  /** Closes the dialog and opens `href`. */
  onNavigate: (href: string) => void;
}

/**
 * The Ctrl+K / Cmd+K command dialog of every app page. Groups: Packages (from the
 * `packageSearch` slot), Go to (nav filtered by role), Actions (built-ins, page actions from
 * `useCommandActions`, theme), Account.
 */
export function CommandMenu({
  role,
  packageSearch: PackageSearch,
}: {
  /** The viewer's role, `null` when anonymous. */
  role: Role | null;
  packageSearch?: ComponentType<PackageSearchProps>;
}) {
  const { open, setOpen, toggle, actions } = useCommandMenu();
  const [query, setQuery] = useState("");
  const router = useRouter();
  const { setTheme } = useTheme();
  const signOut = useSignOut();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  function run(action: () => void) {
    onOpenChange(false);
    action();
  }

  const navigate = (href: string) => run(() => router.push(href));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command menu" description="Search packages, pages and actions">
      <CommandInput placeholder="Search packages, pages, actions…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {PackageSearch && <PackageSearch query={query} onNavigate={navigate} />}
        <CommandGroup heading="Go to">
          {navItemsFor(role).map((item) => {
            const Icon = NAV_ICONS[item.id];
            return (
              <CommandItem key={item.id} value={`Go to ${item.title}`} onSelect={() => navigate(item.href)}>
                <Icon />
                {item.title}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          {role && (
            <CommandItem value="Create API key" onSelect={() => navigate("/keys?create=1")}>
              <KeyRoundIcon />
              Create API key
            </CommandItem>
          )}
          {role === "admin" && (
            <CommandItem value="Create repository" onSelect={() => navigate("/repositories?create=1")}>
              <PlusIcon />
              Create repository
            </CommandItem>
          )}
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <CommandItem key={action.id} value={action.id} keywords={[action.label, ...(action.keywords ?? [])]} onSelect={() => run(action.onSelect)}>
                {Icon && <Icon />}
                {action.label}
              </CommandItem>
            );
          })}
          <CommandItem value="Theme: Light" onSelect={() => run(() => setTheme("light"))}>
            <SunIcon />
            Theme: Light
          </CommandItem>
          <CommandItem value="Theme: Dark" onSelect={() => run(() => setTheme("dark"))}>
            <MoonIcon />
            Theme: Dark
          </CommandItem>
          <CommandItem value="Theme: System" onSelect={() => run(() => setTheme("system"))}>
            <MonitorIcon />
            Theme: System
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Account">
          {role ? (
            <>
              <CommandItem value="Account" onSelect={() => navigate("/account")}>
                <UserIcon />
                Account
              </CommandItem>
              <CommandItem value="Sign out" onSelect={() => run(() => void signOut())}>
                <LogOutIcon />
                Sign out
              </CommandItem>
            </>
          ) : (
            <CommandItem value="Sign in" onSelect={() => navigate("/login")}>
              <LogInIcon />
              Sign in
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
