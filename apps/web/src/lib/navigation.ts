import type { Role } from "@weaver/core";

/** Where a nav item sits in the sidebar. */
export type NavSection = "registry" | "admin";

/** One destination of the app shell, shared by the sidebar and the command dialog's "Go to" group. */
export interface NavItem {
  id: "dashboard" | "browse" | "repositories" | "keys" | "users" | "settings" | "audit" | "usage";
  title: string;
  href: string;
  section: NavSection;
  /** Who sees the item: everyone (also anonymous visitors), any signed-in user, or admins only. */
  audience: "everyone" | "signed-in" | "admin";
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: "dashboard", title: "Dashboard", href: "/dashboard", section: "registry", audience: "everyone" },
  { id: "browse", title: "Browse", href: "/browse", section: "registry", audience: "everyone" },
  { id: "repositories", title: "Repositories", href: "/repositories", section: "registry", audience: "signed-in" },
  { id: "keys", title: "API keys", href: "/keys", section: "registry", audience: "signed-in" },
  { id: "users", title: "Users", href: "/admin/users", section: "admin", audience: "admin" },
  { id: "settings", title: "Settings", href: "/admin/settings", section: "admin", audience: "admin" },
  { id: "usage", title: "Usage", href: "/admin/stats", section: "admin", audience: "admin" },
  { id: "audit", title: "Audit log", href: "/admin/audit", section: "admin", audience: "admin" },
];

/** The nav items visible to `role`; `null` stands for an anonymous visitor. */
export function navItemsFor(role: Role | null): NavItem[] {
  return NAV_ITEMS.filter((item) => {
    if (item.audience === "everyone") return true;
    if (item.audience === "signed-in") return role !== null;
    return role === "admin";
  });
}

/** Whether `pathname` is `href` itself or one of its sub pages. */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
