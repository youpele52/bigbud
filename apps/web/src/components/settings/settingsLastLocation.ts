import { SETTINGS_NAV_ITEMS, type SettingsSectionPath } from "./SettingsSidebarNav.items";

/**
 * Remembers where the user was in Settings (last page and each page's scroll position) so
 * reopening Settings returns there. In memory only: an app restart opens General again.
 */
const DEFAULT_SETTINGS_PATH: SettingsSectionPath = "/settings/general";

let lastSettingsPath: SettingsSectionPath = DEFAULT_SETTINGS_PATH;
const scrollByPath = new Map<SettingsSectionPath, number>();

function isSettingsSectionPath(value: unknown): value is SettingsSectionPath {
  return SETTINGS_NAV_ITEMS.some((item) => item.to === value);
}

/** The last Settings page visited in this session, or General. */
export function readLastSettingsPath(): SettingsSectionPath {
  return lastSettingsPath;
}

export function rememberSettingsPath(path: string): void {
  if (isSettingsSectionPath(path)) lastSettingsPath = path;
}

/** The scroll offset saved for a Settings page in this session, or 0. */
export function readSettingsScroll(path: string): number {
  return isSettingsSectionPath(path) ? (scrollByPath.get(path) ?? 0) : 0;
}

export function rememberSettingsScroll(path: string, top: number): void {
  if (isSettingsSectionPath(path)) scrollByPath.set(path, Math.max(0, Math.round(top)));
}

/** Test helper: forget everything remembered in this session. */
export function resetSettingsLastLocation(): void {
  lastSettingsPath = DEFAULT_SETTINGS_PATH;
  scrollByPath.clear();
}
