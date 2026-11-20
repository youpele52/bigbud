import { useCallback, useState } from "react";
import {
  ShieldIcon,
  FolderOpenIcon,
  CheckIcon,
  XIcon,
  RotateCcwIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { OS_INDEX_COMMON_FOLDERS } from "@bigbud/shared/search/osIndexScopeFolders";
import { updateServerSettings, useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { fileAccessServerPatch } from "../../hooks/useSettings.fileAccessMirror";
import { probeFileAccessLevel } from "../../hooks/useSettings.fileAccessProbe";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SETTINGS_ANCHORS, SettingsAnchorLink, useSettingsAnchorTarget } from "./settingsAnchor";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { readNativeApi } from "../../rpc/nativeApi";

const PERMISSION_LEVEL_OPTIONS = [
  { value: "unrestricted" as const, label: "All files and folders" },
  { value: "common-folders" as const, label: "Commonly used folders only" },
  { value: "none" as const, label: "No access" },
] as const;

// The same folders "Search this computer" uses at the common-folders level.
const COMMON_FOLDERS = OS_INDEX_COMMON_FOLDERS.map((name) => ({ key: name, label: name }));

function getFolderAccessMap(
  permissionLevel: "none" | "common-folders" | "unrestricted",
): Record<string, boolean> {
  const hasCommonFolderAccess =
    permissionLevel === "common-folders" || permissionLevel === "unrestricted";
  return Object.fromEntries(COMMON_FOLDERS.map((folder) => [folder.key, hasCommonFolderAccess]));
}

export function FileAccessSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [isResetting, setIsResetting] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const accessMap = getFolderAccessMap(settings.fileAccessPermissionLevel);
  const targeted = useSettingsAnchorTarget(SETTINGS_ANCHORS.fileAccessPermissionLevel);

  const handlePickDefaultChatFolder = useCallback(async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (pickedPath) {
        updateSettings({ defaultChatCwd: pickedPath });
      }
    } catch {
      // Ignore picker failures.
    }
    setIsPickingFolder(false);
  }, [isPickingFolder, updateSettings]);

  const handleResetPermissions = useCallback(async () => {
    setIsResetting(true);
    // Re-ask only the File Access question, never the whole welcome tour.
    updateSettings({
      hasSeenFileAccessPrompt: false,
      hasSeenWelcomeTour: true,
      fileAccessPermissionLevel: "none",
    });
    updateServerSettings(fileAccessServerPatch("none"));
    setIsResetting(false);
  }, [updateSettings]);

  const handleOpenSystemSettings = useCallback(() => {
    const api = readNativeApi();
    if (api) {
      void api.shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
      );
    }
  }, []);

  return (
    <SettingsSection title="File Access" icon={<ShieldIcon className="size-3" />}>
      <SettingsRow
        title="Default chat folder"
        description="Used as the working directory for chats in the Chats section when they are not tied to a project folder."
        resetAction={
          settings.defaultChatCwd !== DEFAULT_UNIFIED_SETTINGS.defaultChatCwd ? (
            <SettingResetButton
              label="default chat folder"
              onClick={() =>
                updateSettings({
                  defaultChatCwd: DEFAULT_UNIFIED_SETTINGS.defaultChatCwd,
                })
              }
            />
          ) : null
        }
        control={
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-1.5 sm:w-64"
            aria-label="Default chat folder"
            disabled={isPickingFolder}
            onClick={() => void handlePickDefaultChatFolder()}
          >
            <FolderOpenIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-light">{settings.defaultChatCwd}</span>
          </Button>
        }
      />

      <SettingsRow
        id={SETTINGS_ANCHORS.fileAccessPermissionLevel}
        forceVisible={targeted}
        title="Permission level"
        description="Control which files and folders bigbud and its search can access on your system."
        status={
          <span>
            Also sets which folders "Search this computer" covers. macOS asks for access when you
            choose a level, not while you search.{" "}
            <SettingsAnchorLink anchorId={SETTINGS_ANCHORS.searchThisComputer}>
              Go to Search this computer
            </SettingsAnchorLink>
          </span>
        }
        control={
          <Select
            value={settings.fileAccessPermissionLevel}
            onValueChange={(value) => {
              if (value === "none" || value === "common-folders" || value === "unrestricted") {
                updateSettings({ fileAccessPermissionLevel: value });
                // The server enforces the "this computer" search scope from its mirror.
                updateServerSettings(fileAccessServerPatch(value));
                // macOS asks for every folder the AI and search may read now, not mid-search.
                void probeFileAccessLevel(value);
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full sm:w-56"
              aria-label="File access permission level"
            >
              <SelectValue>
                {PERMISSION_LEVEL_OPTIONS.find(
                  (o) => o.value === settings.fileAccessPermissionLevel,
                )?.label ?? "No access"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {PERMISSION_LEVEL_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      {settings.fileAccessPermissionLevel !== "none" && (
        <SettingsRow
          title="Folder access status"
          description="Saved access scope for commonly used folders, for the AI and for search."
        >
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {COMMON_FOLDERS.map((folder) => {
              const hasAccess = accessMap[folder.key] ?? false;
              return (
                <div
                  key={folder.key}
                  className="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs"
                >
                  <FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{folder.label}</span>
                  {hasAccess ? (
                    <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <XIcon className="size-3.5 shrink-0 text-destructive" />
                  )}
                </div>
              );
            })}
          </div>
        </SettingsRow>
      )}

      <SettingsRow
        title="Reset permissions"
        description="Clear the saved preference so bigbud asks you again before using expanded file access."
        control={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            disabled={isResetting}
            onClick={() => void handleResetPermissions()}
          >
            <RotateCcwIcon className="size-3" />
            Reset
          </Button>
        }
      />

      {/mac/i.test(navigator.platform) && (
        <SettingsRow
          title="System Settings"
          description="Manage file access permissions in macOS System Settings."
          control={
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={handleOpenSystemSettings}
            >
              Open
              <ArrowUpRightIcon className="size-3" />
            </Button>
          }
        />
      )}
    </SettingsSection>
  );
}
