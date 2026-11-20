/**
 * Choosing a File Access level is the single moment bigbud asks for file access, for the AI and
 * for "Search this computer". The desktop probe opens every folder search reads at that level,
 * so macOS shows its privacy prompts then (iCloud Drive included), never mid-search. The probed
 * level is remembered so users who chose a level before the probe covered search get it once at
 * launch, and nobody is asked again for a level already probed.
 */
import type { FileAccessPermissionLevel } from "@bigbud/contracts/core/settings.search.ts";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/settings";

import { readNativeApi } from "~/rpc/nativeApi";
import { getServerConfig } from "~/rpc/serverState";
import { getLocalStorageItem } from "./useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "./useSettings.storage";

export const FILE_ACCESS_PROBE_STORAGE_KEY = "bigbud:file-access-probe:v1";

/** Runs the File Access probe for a newly chosen level and records it. Never throws. */
export async function probeFileAccessLevel(
  level: FileAccessPermissionLevel,
  storage: Storage = localStorage,
): Promise<void> {
  if (level === "none") return;
  const api = readNativeApi();
  if (!api) return;
  try {
    // Declined folders come back in `denied`; search skips them, so there is nothing to report.
    await api.fileAccess.request(level);
  } catch {
    return;
  }
  storage.setItem(FILE_ACCESS_PROBE_STORAGE_KEY, level);
}

/** Probes `level` unless it was already probed. For turning "Search this computer" back on. */
export function ensureFileAccessProbed(
  level: FileAccessPermissionLevel,
  storage: Storage = localStorage,
): void {
  if (level === "none" || storage.getItem(FILE_ACCESS_PROBE_STORAGE_KEY) === level) return;
  void probeFileAccessLevel(level, storage);
}

/**
 * Call once on startup, after the server config is known: probes the saved level when "Search
 * this computer" is on and that level was never probed.
 */
export function probeFileAccessOnStartup(storage: Storage = localStorage): void {
  const config = getServerConfig();
  if (!config?.settings.search.thisComputer) return;
  const client =
    getLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      ClientSettingsSchema,
      CLIENT_SETTINGS_STORAGE_OPTIONS,
    ) ?? DEFAULT_CLIENT_SETTINGS;
  ensureFileAccessProbed(client.fileAccessPermissionLevel, storage);
}
