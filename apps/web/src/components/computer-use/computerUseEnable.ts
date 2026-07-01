import type { QueryClient } from "@tanstack/react-query";
import type { UnifiedSettings } from "@bigbud/contracts/settings";
import {
  desktopComputerUseQueryKeys,
  setDesktopComputerUsePermissionsQueryData,
  setDesktopComputerUseStatusQueryData,
} from "../../lib/desktopComputerUseReactQuery";
import { toastManager } from "../ui/toast";

interface EnableComputerUseOptions {
  readonly queryClient: QueryClient;
  readonly updateSettings: (patch: Partial<UnifiedSettings>) => void;
  readonly closePrompt?: () => void;
}

export function enableComputerUseInBackground(options: EnableComputerUseOptions): void {
  options.updateSettings({
    computerUseEnabled: true,
    hasSeenComputerUsePrompt: true,
  });
  options.closePrompt?.();
  void ensureComputerUseReady(options);
}

async function ensureComputerUseReady({ queryClient }: EnableComputerUseOptions): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) {
    return;
  }

  try {
    let runtimeStatus = await bridge.getComputerUseRuntimeStatus();
    setDesktopComputerUseStatusQueryData(queryClient, runtimeStatus);

    if (!runtimeStatus.available) {
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
          description:
            installResult.status.message ?? "bigbud could not install the desktop runtime.",
        });
        return;
      }
    }

    const permissions = await bridge.requestComputerUsePermissions();
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
      title: "Finish macOS permissions",
      description:
        permissions.message ??
        "Approve Accessibility and Screen Recording to finish enabling Computer Use.",
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Computer Use setup failed",
      description: error instanceof Error ? error.message : "Computer Use could not be enabled.",
    });
  } finally {
    void queryClient.invalidateQueries({ queryKey: desktopComputerUseQueryKeys.status() });
    void queryClient.invalidateQueries({ queryKey: desktopComputerUseQueryKeys.permissions() });
  }
}
