import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";

export const CLIENT_SETTINGS_STORAGE_KEY = "bigbud:client-settings:v2";
export const CLIENT_SETTINGS_LEGACY_KEYS = [
  "bigbud:client-settings:v1",
  "t3code:client-settings:v1",
] as const;

/** The v2 key makes this a one-time change; later explicit Meslo selections stay saved. */
export function migrateClientSettingsFont(settings: ClientSettings): ClientSettings {
  return settings.terminalFontFamily === "meslo-nerd-font-mono"
    ? { ...settings, terminalFontFamily: DEFAULT_CLIENT_SETTINGS.terminalFontFamily }
    : settings;
}

export const CLIENT_SETTINGS_STORAGE_OPTIONS = {
  legacyKeys: CLIENT_SETTINGS_LEGACY_KEYS,
  migrateLegacyValue: migrateClientSettingsFont,
};
