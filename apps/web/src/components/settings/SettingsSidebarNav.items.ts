import type { ComponentType } from "react";
import {
  ArchiveIcon,
  BellIcon,
  BotIcon,
  InfoIcon,
  KeyboardIcon,
  Settings2Icon,
  WaypointsIcon,
} from "lucide-react";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/notifications"
  | "/settings/providers"
  | "/settings/ai"
  | "/settings/keybindings"
  | "/settings/archived"
  | "/settings/about";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Notifications", to: "/settings/notifications", icon: BellIcon },
  { label: "Providers", to: "/settings/providers", icon: WaypointsIcon },
  { label: "AI", to: "/settings/ai", icon: BotIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
  { label: "About", to: "/settings/about", icon: InfoIcon },
];
