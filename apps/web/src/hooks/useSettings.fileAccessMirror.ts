/**
 * File Access is edited in the client settings, but "Search this computer" is enforced on the
 * server (plan Q2), so the level is mirrored into `ServerSettings.search.fileAccessLevel`. The
 * File Access section writes both; this one-time step copies a level chosen before the mirror
 * existed. The server value then decides the "this computer" scope.
 */
import type { FileAccessPermissionLevel } from "@bigbud/contracts/core/settings.search.ts";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/settings";

import { getServerConfig } from "~/rpc/serverState";
import { getLocalStorageItem } from "./useLocalStorage";
import { updateServerSettings } from "./useSettings";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "./useSettings.storage";

export const FILE_ACCESS_MIRROR_STORAGE_KEY = "bigbud:file-access-server-mirror:v1";

/** The patch that keeps the server mirror equal to a newly chosen File Access level. */
export function fileAccessServerPatch(level: FileAccessPermissionLevel) {
  return { search: { fileAccessLevel: level } } as const;
}

/** Call once on startup, after the server config is known. Never lowers or overwrites a server value. */
export function mirrorFileAccessLevelToServer(storage: Storage = localStorage): void {
  if (storage.getItem(FILE_ACCESS_MIRROR_STORAGE_KEY)) return;
  const config = getServerConfig();
  if (!config) return;
  const client =
    getLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      ClientSettingsSchema,
      CLIENT_SETTINGS_STORAGE_OPTIONS,
    ) ?? DEFAULT_CLIENT_SETTINGS;
  if (
    client.fileAccessPermissionLevel !== "none" &&
    config.settings.search.fileAccessLevel === "none"
  ) {
    updateServerSettings(fileAccessServerPatch(client.fileAccessPermissionLevel));
  }
  storage.setItem(FILE_ACCESS_MIRROR_STORAGE_KEY, "1");
}
