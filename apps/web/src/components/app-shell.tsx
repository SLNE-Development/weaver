"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsUpDownIcon, LogInIcon, LogOutIcon, SearchIcon, UserIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@weaver/ui/components/avatar";
import { Button } from "@weaver/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weaver/ui/components/dropdown-menu";
import { Kbd, KbdGroup } from "@weaver/ui/components/kbd";
import { Logo } from "@weaver/ui/components/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@weaver/ui/components/sidebar";
import { ThemeToggle } from "@weaver/ui/components/theme-toggle";
import { isNavActive, navItemsFor, type NavItem } from "@/lib/navigation";
import type { SessionUser } from "@/server/session";
import { CommandMenuProvider, useCommandMenu } from "./command-actions";
import { CommandMenu } from "./command-menu";
import { NAV_ICONS } from "./nav-icons";
import { PackageSearch } from "./package-search";
import { useSignOut } from "./use-sign-out";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}` : name.slice(0, 2)).toUpperCase() || "?";
}

function SearchButton() {
  const { setOpen } = useCommandMenu();
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setOpen(true)}
      className="w-full justify-start border-sidebar-border bg-sidebar-accent/40 px-2 font-normal text-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:border-sidebar-border dark:bg-sidebar-accent/40 dark:hover:bg-sidebar-accent"
    >
      <SearchIcon />
      <span className="flex-1 text-left">Search…</span>
      <KbdGroup>
        <Kbd className="bg-sidebar-accent text-sidebar-foreground">{mac ? "⌘" : "Ctrl"}</Kbd>
        <Kbd className="bg-sidebar-accent text-sidebar-foreground">K</Kbd>
      </KbdGroup>
    </Button>
  );
}

function NavGroup({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  if (items.length === 0) return null;
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const Icon = NAV_ICONS[item.id];
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton asChild isActive={isNavActive(pathname, item.href)}>
                  <Link href={item.href}>
                    <Icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function UserMenu({ user }: { user: SessionUser }) {
  const signOut = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg" aria-label="User menu" className="data-[state=open]:bg-sidebar-accent">
          <Avatar size="sm" className="rounded-md">
            {user.image && <AvatarImage src={user.image} alt="" />}
            <AvatarFallback className="rounded-md text-[10px]">{initials(user.name)}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium text-sidebar-accent-foreground">{user.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{user.role}</span>
          </span>
          <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="truncate font-medium">{user.name}</span>
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/account">
              <UserIcon />
              Account
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The signed-in (or anonymous-view) app frame: a dark sidebar with the logo, the command dialog
 * trigger, nav filtered by role and the user menu, next to the page content. Mounts the command
 * dialog once for every app page.
 */
export function AppShell({ user, children }: { user: SessionUser | null; children: ReactNode }) {
  const pathname = usePathname();
  const role = user?.role ?? null;
  const items = navItemsFor(role);

  return (
    <CommandMenuProvider>
      <SidebarProvider>
        <Sidebar>
          {/* `dark` scopes dark tokens to the sidebar's controls; the sidebar is dark in both themes. */}
          <div className="dark contents">
            <SidebarHeader className="gap-3 px-3 pt-4">
              <Link href={role ? "/dashboard" : "/"} className="flex items-center gap-2 px-1 text-sidebar-accent-foreground">
                <Logo variant="full" />
              </Link>
              <SearchButton />
            </SidebarHeader>
            <SidebarContent>
              <NavGroup label="Registry" items={items.filter((item) => item.section === "registry")} pathname={pathname} />
              <NavGroup label="Admin" items={items.filter((item) => item.section === "admin")} pathname={pathname} />
            </SidebarContent>
            <SidebarFooter className="border-t border-sidebar-border">
              <div className="flex items-center gap-1">
                <SidebarMenu className="min-w-0 flex-1">
                  <SidebarMenuItem>
                    {user ? (
                      <UserMenu user={user} />
                    ) : (
                      <Button asChild size="sm" variant="secondary" className="w-full">
                        <Link href={`/login?next=${encodeURIComponent(pathname)}`}>
                          <LogInIcon />
                          Sign in
                        </Link>
                      </Button>
                    )}
                  </SidebarMenuItem>
                </SidebarMenu>
                <ThemeToggle className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
              </div>
            </SidebarFooter>
          </div>
        </Sidebar>
        <SidebarInset className="min-w-0">
          <header className="flex h-12 items-center gap-2 border-b px-3 md:hidden">
            <SidebarTrigger />
            <Logo />
          </header>
          {children}
        </SidebarInset>
        <CommandMenu role={role} packageSearch={PackageSearch} />
      </SidebarProvider>
    </CommandMenuProvider>
  );
}
