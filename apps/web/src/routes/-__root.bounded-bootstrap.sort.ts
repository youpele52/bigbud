import { isBuiltInChatsProject } from "@bigbud/contracts/constants/project.constant.ts";
import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ThreadSummarySortOrder } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "@bigbud/contracts/core/settings.ts";

import { getLocalStorageItem } from "../hooks/useLocalStorage";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_OPTIONS,
} from "../hooks/useSettings.storage";

/**
 * The order the sidebar displays a project's threads in, so server pages continue that order:
 * Chats follow their own sort setting, every other project the thread sort setting.
 */
export function readSidebarThreadSortOrder(projectId: ProjectId): ThreadSummarySortOrder {
  let settings = DEFAULT_CLIENT_SETTINGS;
  try {
    settings =
      getLocalStorageItem(
        CLIENT_SETTINGS_STORAGE_KEY,
        ClientSettingsSchema,
        CLIENT_SETTINGS_STORAGE_OPTIONS,
      ) ?? DEFAULT_CLIENT_SETTINGS;
  } catch {
    // Unreadable settings fall back to the default order, which the server pages too.
  }
  return isBuiltInChatsProject(projectId)
    ? settings.sidebarChatsSortOrder
    : settings.sidebarThreadSortOrder;
}
