import { ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import * as Schema from "effect/Schema";

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

const isProviderKind = Schema.is(ProviderKind);

/**
 * One-time move of `hiddenComposerProviders` from browser storage to server settings (OD1), so the
 * server can honor hidden providers with no client connected. A non-empty local list fills an
 * empty server list; the local key is dropped either way. Idempotent: later runs find nothing.
 */
export function migrateHiddenComposerProvidersToServer(input: {
  readonly serverHiddenComposerProviders: ReadonlyArray<ProviderKind>;
  readonly patchServer: (hidden: ReadonlyArray<ProviderKind>) => void;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}): "migrated" | "dropped" | "none" {
  const storage =
    input.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!storage) return "none";
  let found: ReadonlyArray<ProviderKind> = [];
  let dropped = false;
  for (const key of [CLIENT_SETTINGS_STORAGE_KEY, ...CLIENT_SETTINGS_LEGACY_KEYS]) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || !("hiddenComposerProviders" in parsed)) {
      continue;
    }
    const { hiddenComposerProviders, ...rest } = parsed as Record<string, unknown>;
    if (found.length === 0 && Array.isArray(hiddenComposerProviders)) {
      found = hiddenComposerProviders.filter(isProviderKind);
    }
    storage.setItem(key, JSON.stringify(rest));
    dropped = true;
  }
  if (found.length > 0 && input.serverHiddenComposerProviders.length === 0) {
    input.patchServer(found);
    return "migrated";
  }
  return dropped ? "dropped" : "none";
}
