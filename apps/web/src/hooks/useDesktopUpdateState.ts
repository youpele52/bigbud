import { useCallback, useEffect, useState } from "react";
import { type DesktopUpdateState } from "@bigbud/contracts";
import { isElectron } from "../config/env";
import { toastManager } from "../components/ui/toast";
import {
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  isUnsignedBuildBlocked,
  resolveDesktopUpdateButtonAction,
  shouldToastDesktopUpdateActionResult,
} from "../components/layout/desktopUpdate.logic";

/** Latest releases page — opened for Linux non-AppImage builds as an install fallback. */
const RELEASES_URL = "https://github.com/pingdotgg/t3code/releases/latest";

export interface UseDesktopUpdateStateResult {
  desktopUpdateState: DesktopUpdateState | null;
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateButtonAction: ReturnType<typeof resolveDesktopUpdateButtonAction> | "none";
  handleDesktopUpdateButtonClick: () => void;
}

/** Subscribes to desktop update state from the Electron bridge and exposes action handlers. */
export function useDesktopUpdateState(): UseDesktopUpdateStateResult {
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "open-download") {
      void bridge.openExternal(RELEASES_URL).catch(() => undefined);
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            if (desktopUpdateState && isUnsignedBuildBlocked(result.state)) {
              toastManager.add({
                type: "info",
                title: "Update downloaded",
                description:
                  "This unsigned build cannot auto-install. Go to Settings → About to install manually.",
              });
            } else {
              toastManager.add({
                type: "success",
                title: "Update downloaded",
                description: "Restart the app from the update button to install it.",
              });
            }
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  return {
    desktopUpdateState,
    desktopUpdateButtonDisabled,
    desktopUpdateButtonAction,
    handleDesktopUpdateButtonClick,
  };
}
