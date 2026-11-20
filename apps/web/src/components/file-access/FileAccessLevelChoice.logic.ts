import type { FileAccessPermissionLevel } from "@bigbud/contracts/core/settings.search.ts";

import { updateServerSettings, type useUpdateSettings } from "../../hooks/useSettings";
import { fileAccessServerPatch } from "../../hooks/useSettings.fileAccessMirror";
import { probeFileAccessLevel } from "../../hooks/useSettings.fileAccessProbe";

/** The two levels offered when bigbud first asks; "No access" stays a Settings-only choice. */
export type FileAccessPromptLevel = Exclude<FileAccessPermissionLevel, "none">;

type UpdateSettings = ReturnType<typeof useUpdateSettings>["updateSettings"];

/**
 * Records the first-launch File Access answer: the client level, the server mirror that scopes
 * "Search this computer", and the probe that makes macOS ask now rather than mid-search.
 */
export async function applyFileAccessChoice(
  level: FileAccessPromptLevel,
  updateSettings: UpdateSettings,
): Promise<void> {
  updateSettings({ fileAccessPermissionLevel: level, hasSeenFileAccessPrompt: true });
  updateServerSettings(fileAccessServerPatch(level));
  // The one moment macOS asks: every folder the AI and search may read is opened now.
  await probeFileAccessLevel(level);
}
