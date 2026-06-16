import { useCallback, useState } from "react";
import {
  ShieldIcon,
  FolderOpenIcon,
  CheckIcon,
  XIcon,
  RotateCcwIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { readNativeApi } from "../../rpc/nativeApi";

const PERMISSION_LEVEL_OPTIONS = [
  { value: "unrestricted" as const, label: "All files and folders" },
  { value: "common-folders" as const, label: "Commonly used folders only" },
  { value: "none" as const, label: "No access" },
] as const;

const COMMON_FOLDERS = [
  { key: "Desktop", label: "Desktop" },
  { key: "Documents", label: "Documents" },
  { key: "Downloads", label: "Downloads" },
  { key: "Music", label: "Music" },
  { key: "Pictures", label: "Pictures" },
] as const;

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
    updateSettings({
      hasSeenFileAccessPrompt: false,
      fileAccessPermissionLevel: "none",
    });
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
            className="w-full justify-start gap-2 sm:w-64"
            aria-label="Default chat folder"
            disabled={isPickingFolder}
            onClick={() => void handlePickDefaultChatFolder()}
          >
            <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{settings.defaultChatCwd}</span>
          </Button>
        }
      />

      <SettingsRow
        title="Permission level"
        description="Control which files and folders bigbud can access on your system."
        control={
          <Select
            value={settings.fileAccessPermissionLevel}
            onValueChange={(value) => {
              if (value === "none" || value === "common-folders" || value === "unrestricted") {
                updateSettings({ fileAccessPermissionLevel: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label="File access permission level">
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
          description="Saved access scope for commonly used folders. macOS may still prompt when protected folders are first accessed."
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
              <ExternalLinkIcon className="size-3" />
              Open
            </Button>
          }
        />
      )}
    </SettingsSection>
  );
}
