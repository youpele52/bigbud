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
 * server can honor hidden providers with no client connected. Hiding is a safety preference, so a
 * local list is unioned into the server's (fails closed). The local key is dropped only after the
 * server confirms the patch; a failed patch keeps it and the next start retries. Idempotent.
 */
export async function migrateHiddenComposerProvidersToServer(input: {
  readonly serverHiddenComposerProviders: ReadonlyArray<ProviderKind>;
  readonly patchServer: (hidden: ReadonlyArray<ProviderKind>) => Promise<unknown>;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}): Promise<"migrated" | "dropped" | "none" | "failed"> {
  const storage =
    input.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!storage) return "none";
  const entries: Array<{ readonly key: string; readonly rest: Record<string, unknown> }> = [];
  const merged = new Set<ProviderKind>(input.serverHiddenComposerProviders);
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
    if (Array.isArray(hiddenComposerProviders)) {
      for (const provider of hiddenComposerProviders.filter(isProviderKind)) merged.add(provider);
    }
    entries.push({ key, rest });
  }
  if (entries.length === 0) return "none";
  const patched = merged.size > new Set(input.serverHiddenComposerProviders).size;
  if (patched) {
    try {
      await input.patchServer([...merged]);
    } catch {
      return "failed";
    }
  }
  for (const { key, rest } of entries) storage.setItem(key, JSON.stringify(rest));
  return patched ? "migrated" : "dropped";
}
