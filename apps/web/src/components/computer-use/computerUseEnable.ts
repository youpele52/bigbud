import type { QueryClient } from "@tanstack/react-query";
import type { DesktopComputerUseRuntimeStatus } from "@bigbud/contracts";
import type { UnifiedSettings } from "@bigbud/contracts/settings";
import {
  desktopComputerUseQueryKeys,
  setDesktopComputerUsePermissionsQueryData,
  setDesktopComputerUseStatusQueryData,
} from "../../lib/desktopComputerUseReactQuery";
import { toastManager } from "../ui/toast";
import {
  getComputerUsePermissionsToastDescription,
  getComputerUsePermissionsToastTitle,
} from "./computerUsePlatformCopy";
import { normalizeComputerUsePermissionMessage } from "./computerUsePermissionMessage";

interface EnableComputerUseOptions {
  readonly queryClient: QueryClient;
  readonly updateSettings: (patch: Partial<UnifiedSettings>) => void;
  readonly closePrompt?: () => void;
}

export function needsComputerUseRuntimeRepair(status: DesktopComputerUseRuntimeStatus): boolean {
  return status.repairRequired;
}

export function enableComputerUseInBackground(options: EnableComputerUseOptions): void {
  options.updateSettings({
    computerUseEnabled: true,
  });
  options.closePrompt?.();
  void ensureComputerUseReady(options);
}

async function ensureComputerUseReady({ queryClient }: EnableComputerUseOptions): Promise<void> {
  const bridge = window.desktopBridge;
  let refreshPermissions = true;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (!bridge) {
    return;
  }

  try {
    let runtimeStatus = await bridge.getComputerUseRuntimeStatus();
    setDesktopComputerUseStatusQueryData(queryClient, runtimeStatus);

    if (needsComputerUseRuntimeRepair(runtimeStatus)) {
      toastManager.add({
        type: "info",
        title: "Setting up Computer Use",
        description: "bigbud is preparing desktop automation in the background.",
      });

      const installResult = await bridge.installComputerUseRuntime();
      runtimeStatus = installResult.status;
      setDesktopComputerUseStatusQueryData(queryClient, runtimeStatus);

      if (!installResult.ok) {
        toastManager.add({
          type: "error",
          title: "Computer Use setup failed",
          description: installResult.status.message
            ? normalizeComputerUsePermissionMessage(installResult.status.message)
            : "bigbud could not install the desktop runtime.",
        });
        return;
      }
    }

    if (!runtimeStatus.ready && runtimeStatus.state !== "degraded") {
      toastManager.add({
        type: "error",
        title: "Computer Use runtime is not ready",
        description: runtimeStatus.lastError
          ? normalizeComputerUsePermissionMessage(runtimeStatus.lastError)
          : runtimeStatus.message
            ? normalizeComputerUsePermissionMessage(runtimeStatus.message)
            : "The desktop automation daemon is not ready.",
      });
      return;
    }

    const permissions = await bridge.requestComputerUsePermissions();
    refreshPermissions = !permissions.pendingHostAccessibilityApproval;
    setDesktopComputerUsePermissionsQueryData(queryClient, permissions);

    if (permissions.granted) {
      toastManager.add({
        type: "success",
        title: "Computer Use enabled",
        description: "Desktop automation is ready to use.",
      });
      return;
    }

    toastManager.add({
      type: "info",
      title: getComputerUsePermissionsToastTitle(platform),
      description: permissions.message
        ? normalizeComputerUsePermissionMessage(permissions.message)
        : getComputerUsePermissionsToastDescription(platform),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Computer Use setup failed",
      description:
        error instanceof Error
          ? normalizeComputerUsePermissionMessage(error.message)
          : "Computer Use could not be enabled.",
    });
  } finally {
    void queryClient.invalidateQueries({ queryKey: desktopComputerUseQueryKeys.status() });
    if (refreshPermissions) {
      void queryClient.invalidateQueries({ queryKey: desktopComputerUseQueryKeys.permissions() });
    }
  }
}
