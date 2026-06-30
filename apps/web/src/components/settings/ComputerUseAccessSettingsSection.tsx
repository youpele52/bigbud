import { useCallback, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DesktopComputerUsePermissionItem } from "@bigbud/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  desktopComputerUsePermissionsQueryOptions,
  setDesktopComputerUsePermissionsQueryData,
  setDesktopComputerUseStatusQueryData,
  useDesktopComputerUsePermissions,
  useDesktopComputerUseStatus,
} from "../../lib/desktopComputerUseReactQuery";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function formatStatusLabel(source: string | undefined): string {
  switch (source) {
    case "bundled":
      return "Bundled with this desktop build.";
    case "managed":
      return "Installed and managed by bigbud.";
    case "system":
      return "Using an existing system installation.";
    default:
      return "Not installed yet.";
  }
}

function formatPermissionLabel(name: string): string {
  switch (name) {
    case "accessibility":
      return "Accessibility";
    case "screen_recording":
      return "Screen Recording";
    default:
      return name.replaceAll("_", " ");
  }
}

function PermissionStatusGrid({
  permissions,
}: {
  permissions: ReadonlyArray<DesktopComputerUsePermissionItem>;
}) {
  if (permissions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Permission status is unavailable until the Computer Use runtime is installed.
      </p>
    );
  }

  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {permissions.map((permission) => (
        <div
          key={permission.name}
          className="flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs"
        >
          <ShieldAlertIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{formatPermissionLabel(permission.name)}</span>
          {permission.granted ? (
            <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <XIcon className="size-3.5 shrink-0 text-destructive" />
          )}
        </div>
      ))}
    </div>
  );
}

export function ComputerUseAccessSettingsSection() {
  const isDesktop = Boolean(readNativeApi());
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const statusQuery = useDesktopComputerUseStatus({ enabled: isDesktop });
  const permissionsQuery = useDesktopComputerUsePermissions({ enabled: isDesktop });
  const status = statusQuery.data ?? null;
  const permissions = permissionsQuery.data ?? null;
  const [isResetting, setIsResetting] = useState(false);

  const installMutation = useMutation({
    mutationFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge?.installComputerUseRuntime) {
        throw new Error("Computer Use runtime installation is only available in the desktop app.");
      }
      return bridge.installComputerUseRuntime();
    },
    onSuccess: (result) => {
      setDesktopComputerUseStatusQueryData(queryClient, result.status);
      void queryClient.invalidateQueries(desktopComputerUsePermissionsQueryOptions());
      toastManager.add({
        type: result.ok ? "success" : "error",
        title: result.ok ? "Computer Use runtime ready" : "Computer Use install failed",
        description: result.status.message ?? undefined,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Computer Use install failed",
        description: error instanceof Error ? error.message : "Install failed.",
      });
    },
  });

  const doctorMutation = useMutation({
    mutationFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge?.runComputerUseDoctor) {
        throw new Error("Computer Use diagnostics are only available in the desktop app.");
      }
      return bridge.runComputerUseDoctor();
    },
    onSuccess: (nextStatus) => {
      setDesktopComputerUseStatusQueryData(queryClient, nextStatus);
      toastManager.add({
        type: nextStatus.diagnostics ? "success" : "error",
        title: "Computer Use diagnostics completed",
        description: nextStatus.message ?? undefined,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Computer Use diagnostics failed",
        description: error instanceof Error ? error.message : "Diagnostics failed.",
      });
    },
  });

  const requestPermissionsMutation = useMutation({
    mutationFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge?.requestComputerUsePermissions) {
        throw new Error("Computer Use permissions are only available in the desktop app.");
      }
      return bridge.requestComputerUsePermissions();
    },
    onSuccess: (nextStatus) => {
      setDesktopComputerUsePermissionsQueryData(queryClient, nextStatus);
      toastManager.add({
        type: nextStatus.granted ? "success" : "info",
        title: nextStatus.granted ? "Desktop permissions granted" : "Desktop permissions needed",
        description:
          nextStatus.message ??
          "macOS may still require approval in System Settings for Accessibility and Screen Recording.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Permission request failed",
        description: error instanceof Error ? error.message : "Request failed.",
      });
    },
  });

  const handleOpenAccessibilitySettings = useCallback(() => {
    const api = readNativeApi();
    if (api) {
      void api.shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    }
  }, []);

  const handleOpenScreenRecordingSettings = useCallback(() => {
    const api = readNativeApi();
    if (api) {
      void api.shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    }
  }, []);

  const handleResetPrompt = useCallback(() => {
    setIsResetting(true);
    updateSettings({
      hasSeenComputerUsePrompt: false,
      computerUseEnabled: false,
    });
    setIsResetting(false);
  }, [updateSettings]);

  if (!isDesktop) {
    return null;
  }

  return (
    <SettingsSection title="Computer Use" icon={<BotIcon className="size-3" />}>
      <SettingsRow
        title="Enable desktop automation"
        description="Allow agents to control native macOS apps such as Calendar and Reminders, capture screens, and interact through accessibility."
        control={
          <Switch
            checked={settings.computerUseEnabled}
            onCheckedChange={(checked) => updateSettings({ computerUseEnabled: Boolean(checked) })}
            aria-label="Enable desktop computer use"
          />
        }
      />

      {!settings.computerUseEnabled ? (
        <SettingsRow
          title="Limited capability"
          description="With desktop automation disabled, agents cannot open or read native apps like Calendar or Reminders. Browser automation inside bigbud may still work."
        />
      ) : null}

      <SettingsRow
        title="macOS permissions"
        description="Desktop automation requires Accessibility and Screen Recording access. macOS will prompt when permissions are first requested."
        status={
          permissionsQuery.isLoading ? (
            "Checking permission status."
          ) : permissions ? (
            <div className="space-y-2">
              <PermissionStatusGrid permissions={permissions.permissions} />
              {permissions.message ? (
                <p className="text-xs text-muted-foreground">{permissions.message}</p>
              ) : null}
            </div>
          ) : (
            "Permission status unavailable."
          )
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={
              !settings.computerUseEnabled ||
              requestPermissionsMutation.isPending ||
              !status?.available
            }
            onClick={() => requestPermissionsMutation.mutate()}
          >
            Request access
          </Button>
        }
      />

      <SettingsRow
        title="Runtime"
        description="Desktop computer-use actions rely on the Cua driver runtime."
        status={
          status ? (
            <div className="space-y-1">
              <div>{formatStatusLabel(status.source)}</div>
              {status.version ? <div>{status.version}</div> : null}
              {status.message ? <div>{status.message}</div> : null}
            </div>
          ) : statusQuery.isLoading ? (
            "Checking runtime status."
          ) : (
            "Unavailable."
          )
        }
        control={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={doctorMutation.isPending || installMutation.isPending}
              onClick={() => doctorMutation.mutate()}
            >
              Doctor
            </Button>
            <Button
              size="xs"
              disabled={installMutation.isPending || doctorMutation.isPending}
              onClick={() => installMutation.mutate()}
            >
              {status?.available ? "Repair" : "Install"}
            </Button>
          </>
        }
      />

      <SettingsRow
        title="Reset prompt"
        description="Show the first-run Computer Use permission dialog again."
        control={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            disabled={isResetting}
            onClick={handleResetPrompt}
          >
            <RotateCcwIcon className="size-3" />
            Reset
          </Button>
        }
      />

      {/mac/i.test(navigator.platform) ? (
        <SettingsRow
          title="System Settings"
          description="Manage Accessibility and Screen Recording permissions in macOS System Settings."
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={handleOpenAccessibilitySettings}
              >
                <ExternalLinkIcon className="size-3" />
                Accessibility
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={handleOpenScreenRecordingSettings}
              >
                <ExternalLinkIcon className="size-3" />
                Screen Recording
              </Button>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
