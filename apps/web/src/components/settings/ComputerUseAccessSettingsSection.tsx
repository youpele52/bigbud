import { useCallback } from "react";
import {
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  InfoIcon,
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
import { ComputerUseLimitSettingsRows } from "./ComputerUseAccessSettingsSection.limits";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { enableComputerUseInBackground } from "../computer-use/computerUseEnable";
import {
  getComputerUseLimitedCapabilityDescription,
  getComputerUsePermissionsDescription,
  getComputerUsePermissionsRequestFallback,
  getComputerUsePermissionsTitle,
  getComputerUseSettingsDescription,
  isMacComputerUsePlatform,
} from "../computer-use/computerUsePlatformCopy";

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
    case "screen_recording_capturable":
      return "Screen contents capturable";
    default:
      return name.replaceAll("_", " ");
  }
}

export function formatComputerUsePermissionMessage(message: string): string {
  const parts = message
    .split(/(?=✅|❌|ℹ️)/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const informationalParts = parts.filter((part) => part.startsWith("ℹ️"));

  return (informationalParts.length > 0 ? informationalParts : parts)
    .map((part) => part.replace(/^(?:✅|❌|ℹ️)\s*/u, ""))
    .join("\n");
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
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const isMac = isMacComputerUsePlatform(platform);
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const queryClient = useQueryClient();
  const statusQuery = useDesktopComputerUseStatus({ enabled: isDesktop });
  const permissionsQuery = useDesktopComputerUsePermissions({ enabled: isDesktop });
  const status = statusQuery.data ?? null;
  const permissions = permissionsQuery.data ?? null;
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
        type: nextStatus.ready ? "success" : nextStatus.repairRequired ? "error" : "warning",
        title: "Computer Use health check completed",
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
        description: nextStatus.message ?? getComputerUsePermissionsRequestFallback(platform),
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

  const handleComputerUseEnabledChange = useCallback(
    (checked: boolean) => {
      if (!checked) {
        updateSettings({ computerUseEnabled: false });
        return;
      }
      enableComputerUseInBackground({
        queryClient,
        updateSettings,
      });
    },
    [queryClient, updateSettings],
  );

  if (!isDesktop) {
    return null;
  }

  return (
    <SettingsSection title="Computer Use" icon={<BotIcon className="size-3" />}>
      <SettingsRow
        title="Enable desktop automation"
        description={getComputerUseSettingsDescription(platform)}
        control={
          <Switch
            checked={settings.computerUseEnabled}
            onCheckedChange={(checked) => handleComputerUseEnabledChange(Boolean(checked))}
            aria-label="Enable desktop computer use"
          />
        }
      />

      {!settings.computerUseEnabled ? (
        <SettingsRow
          title="Limited capability"
          description={getComputerUseLimitedCapabilityDescription(platform)}
        />
      ) : null}

      <ComputerUseLimitSettingsRows settings={settings} />

      <SettingsRow
        title={getComputerUsePermissionsTitle(platform)}
        description={getComputerUsePermissionsDescription(platform)}
        status={
          permissionsQuery.isLoading
            ? "Checking permission status."
            : !permissions
              ? "Permission status unavailable."
              : undefined
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
            Check access
          </Button>
        }
      >
        {permissions ? (
          <div className="mt-3 space-y-3">
            <PermissionStatusGrid permissions={permissions.permissions} />

            {!permissions.granted &&
            (permissions.message || permissions.pendingHostAccessibilityApproval) ? (
              <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3 shrink-0" />
                <div className="space-y-1">
                  {permissions.message ? (
                    <p className="whitespace-pre-line">
                      {formatComputerUsePermissionMessage(permissions.message)}
                    </p>
                  ) : null}
                  {permissions.pendingHostAccessibilityApproval ? (
                    <p>Waiting for Accessibility approval for the current bigbud desktop app.</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {permissions.source?.attribution || permissions.source?.hostBundleId ? (
              <dl className="space-y-1 border-t border-border/60 pt-3 text-xs">
                {permissions.source.attribution ? (
                  <div className="flex gap-1.5">
                    <dt className="text-muted-foreground">Permission attribution:</dt>
                    <dd className="text-foreground">{permissions.source.attribution}</dd>
                  </div>
                ) : null}
                {permissions.source.hostBundleId ? (
                  <div className="flex min-w-0 gap-1.5">
                    <dt className="shrink-0 text-muted-foreground">Host bundle:</dt>
                    <dd className="break-all font-mono text-[11px] text-foreground">
                      {permissions.source.hostBundleId}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>

      <SettingsRow
        title="Runtime"
        description="Desktop computer-use actions rely on the Cua driver runtime."
        status={
          status ? (
            <div className="space-y-1">
              <div>{formatStatusLabel(status.source)}</div>
              <div>
                Daemon: {status.daemonState}. Platform: {status.platform}/{status.architecture} (
                {status.platformHealth}).
              </div>
              <div>
                Runtime: {status.version ?? "unknown"}; expected {status.expectedVersion}.
              </div>
              <div>
                State: {status.state}. Health: {status.healthSummary ?? "not checked"}. Repair:{" "}
                {status.repairRequired ? "required" : "not required"}. Manifest:{" "}
                {status.manifestSchema ?? "unknown"}.
              </div>
              <div>
                Policy: {status.policyVersion ?? "missing"}
                {status.policySha256 ? ` (${status.policySha256.slice(0, 12)}…)` : ""}.
              </div>
              {status.lastError ? <div>Last error: {status.lastError}</div> : null}
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
              Check health
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

      {isMac ? (
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
