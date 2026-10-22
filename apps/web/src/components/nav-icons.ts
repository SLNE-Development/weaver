import {
  BarChart3Icon,
  DatabaseIcon,
  FolderSearchIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import type { NavItem } from "@/lib/navigation";

/** Icon of each nav destination, shared by the sidebar and the command dialog. */
export const NAV_ICONS: Record<NavItem["id"], LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  browse: FolderSearchIcon,
  repositories: DatabaseIcon,
  keys: KeyRoundIcon,
  users: UsersIcon,
  settings: SettingsIcon,
  usage: BarChart3Icon,
  audit: ScrollTextIcon,
};
