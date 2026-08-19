import type { ComponentType } from "react";
import {
  ArchiveIcon,
  BellIcon,
  BotIcon,
  CpuIcon,
  InfoIcon,
  KeyboardIcon,
  Settings2Icon,
  SmartphoneIcon,
} from "lucide-react";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/notifications"
  | "/settings/providers"
  | "/settings/ai"
  | "/settings/keybindings"
  | "/settings/remote"
  | "/settings/archived"
  | "/settings/about";

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Notifications", to: "/settings/notifications", icon: BellIcon },
  { label: "Providers", to: "/settings/providers", icon: CpuIcon },
  { label: "AI", to: "/settings/ai", icon: BotIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Remote", to: "/settings/remote", icon: SmartphoneIcon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
  { label: "About", to: "/settings/about", icon: InfoIcon },
];

export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<{
  label: string;
  section: string;
  to: SettingsSectionPath;
}> = [
  { label: "Theme", section: "General", to: "/settings/general" },
  { label: "Window material", section: "General", to: "/settings/general" },
  { label: "Time format", section: "General", to: "/settings/general" },
  { label: "Terminal font", section: "General", to: "/settings/general" },
  { label: "Terminal font size", section: "General", to: "/settings/general" },
  { label: "Diff line wrapping", section: "General", to: "/settings/general" },
  { label: "New threads", section: "Threads", to: "/settings/general" },
  { label: "Archive confirmation", section: "Threads", to: "/settings/general" },
  { label: "Delete confirmation", section: "Threads", to: "/settings/general" },
  { label: "Automatic thread cleanup", section: "Threads", to: "/settings/general" },
  { label: "Automatically delete old threads", section: "Threads", to: "/settings/general" },
  { label: "Delete eligible threads now", section: "Threads", to: "/settings/general" },
  { label: "Learning projects", section: "General", to: "/settings/general" },
  { label: "Learning folder", section: "General", to: "/settings/general" },
  { label: "Saved projects", section: "General", to: "/settings/general" },
  { label: "Task completion toasts", section: "Notifications", to: "/settings/notifications" },
  { label: "System notifications", section: "Notifications", to: "/settings/notifications" },
  { label: "Context window warnings", section: "Notifications", to: "/settings/notifications" },
  { label: "Warning threshold", section: "Notifications", to: "/settings/notifications" },
  { label: "Providers", section: "Providers", to: "/settings/providers" },
  { label: "Text generation", section: "AI", to: "/settings/ai" },
  { label: "Stream replies", section: "AI", to: "/settings/ai" },
  { label: "Stream thinking", section: "AI", to: "/settings/ai" },
  { label: "Text generation model", section: "AI", to: "/settings/ai" },
  { label: "Browser", section: "AI", to: "/settings/ai" },
  { label: "Default agent browser", section: "AI", to: "/settings/ai" },
  { label: "bigbud browser", section: "AI", to: "/settings/ai" },
  { label: "System default browser", section: "AI", to: "/settings/ai" },
  { label: "Computer use", section: "AI", to: "/settings/ai" },
  { label: "Enable desktop automation", section: "AI", to: "/settings/ai" },
  { label: "Check-in interval", section: "AI", to: "/settings/ai" },
  { label: "Action timeout", section: "AI", to: "/settings/ai" },
  { label: "File access", section: "AI", to: "/settings/ai" },
  { label: "Default chat folder", section: "AI", to: "/settings/ai" },
  { label: "Permission level", section: "AI", to: "/settings/ai" },
  { label: "Reset permissions", section: "AI", to: "/settings/ai" },
  { label: "Speech to text", section: "AI", to: "/settings/ai" },
  { label: "OpenAI API key", section: "AI", to: "/settings/ai" },
  { label: "Transcription model", section: "AI", to: "/settings/ai" },
  { label: "Keybindings", section: "Keybindings", to: "/settings/keybindings" },
  { label: "Mobile remote", section: "Remote", to: "/settings/remote" },
  { label: "Enable mobile remote control", section: "Remote", to: "/settings/remote" },
  { label: "Tailscale remote backend", section: "Remote", to: "/settings/remote" },
  { label: "Mobile app URL", section: "Remote", to: "/settings/remote" },
  { label: "Backend URL", section: "Remote", to: "/settings/remote" },
  { label: "Active sessions", section: "Remote", to: "/settings/remote" },
  { label: "Archived threads", section: "Archive", to: "/settings/archived" },
  { label: "About", section: "About", to: "/settings/about" },
  { label: "Version", section: "About", to: "/settings/about" },
  { label: "Changelog", section: "About", to: "/settings/about" },
  { label: "Links", section: "About", to: "/settings/about" },
  { label: "Diagnostics", section: "About", to: "/settings/about" },
];
