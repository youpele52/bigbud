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
 * Storage is re-read after the patch, so settings written meanwhile are kept.
 */
export async function migrateHiddenComposerProvidersToServer(input: {
  readonly serverHiddenComposerProviders: ReadonlyArray<ProviderKind>;
  readonly patchServer: (hidden: ReadonlyArray<ProviderKind>) => Promise<unknown>;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}): Promise<"migrated" | "dropped" | "none" | "failed"> {
  const storage =
    input.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!storage) return "none";
  const keys = [CLIENT_SETTINGS_STORAGE_KEY, ...CLIENT_SETTINGS_LEGACY_KEYS];
  const merged = new Set<ProviderKind>(input.serverHiddenComposerProviders);
  let found = false;
  for (const key of keys) {
    const local = readLocalHiddenProviders(storage, key);
    if (local === null) continue;
    found = true;
    for (const provider of local.hidden) merged.add(provider);
  }
  if (!found) return "none";
  const patched = merged.size > new Set(input.serverHiddenComposerProviders).size;
  if (patched) {
    try {
      await input.patchServer([...merged]);
    } catch {
      return "failed";
    }
  }
  for (const key of keys) {
    // Re-read: other settings may have been written while the patch was in flight.
    const local = readLocalHiddenProviders(storage, key);
    if (local === null) continue;
    // A provider hidden meanwhile is not on the server yet; keep it for the next start.
    if (local.hidden.some((provider) => !merged.has(provider))) continue;
    storage.setItem(key, JSON.stringify(local.rest));
  }
  return patched ? "migrated" : "dropped";
}

function readLocalHiddenProviders(
  storage: Pick<Storage, "getItem">,
  key: string,
): { readonly hidden: ReadonlyArray<ProviderKind>; readonly rest: Record<string, unknown> } | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("hiddenComposerProviders" in parsed)) {
    return null;
  }
  const { hiddenComposerProviders, ...rest } = parsed as Record<string, unknown>;
  const hidden = Array.isArray(hiddenComposerProviders)
    ? hiddenComposerProviders.filter(isProviderKind)
    : [];
  return { hidden, rest };
}
