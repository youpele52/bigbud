import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { APP_VERSION } from "../../config/branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/layout/desktopUpdate.logic";
import { resolveAndPersistPreferredEditor } from "../../models/editor";
import { isElectron } from "../../config/env";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { useServerAvailableEditors, useServerObservability } from "../../rpc/serverState";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <span>Version</span>
      <code className="text-[11px] font-medium text-muted-foreground">{APP_VERSION}</code>
    </span>
  );
}

function AboutVersionSection() {
  const queryClient = useQueryClient();
  const updateStateQuery = useDesktopUpdateState();

  const updateState = updateStateQuery.data ?? null;

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          });
        });
      return;
    }

    if (action === "install") {
      const confirmed = window.confirm(
        getDesktopUpdateInstallConfirmationMessage(
          updateState ?? { availableVersion: null, downloadedVersion: null },
        ),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "Install failed.",
          });
        });
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastManager.add({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          });
        }
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not check for updates",
          description: error instanceof Error ? error.message : "Update check failed.",
        });
      });
  }, [queryClient, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    action === "download" || action === "install"
      ? "Update available."
      : "Current version of the application.";

  return (
    <SettingsRow
      title={<AboutVersionTitle />}
      description={description}
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant={action === "install" ? "default" : "outline"}
                disabled={buttonDisabled}
                onClick={handleButtonClick}
              >
                {buttonLabel}
              </Button>
            }
          />
          {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
        </Tooltip>
      }
    />
  );
}

export function AboutSettingsSection() {
  const observability = useServerObservability();
  const availableEditors = useServerAvailableEditors();
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openDiagnosticsError, setOpenDiagnosticsError] = useState<string | null>(null);

  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;

  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const openLogsDirectory = useCallback(() => {
    if (!logsDirectoryPath) return;
    setOpenDiagnosticsError(null);
    setIsOpeningLogsDirectory(true);

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenDiagnosticsError("No available editors found.");
      setIsOpeningLogsDirectory(false);
      return;
    }

    void ensureNativeApi()
      .shell.openInEditor(logsDirectoryPath, editor)
      .catch((error) => {
        setOpenDiagnosticsError(
          error instanceof Error ? error.message : "Unable to open logs folder.",
        );
      })
      .finally(() => {
        setIsOpeningLogsDirectory(false);
      });
  }, [logsDirectoryPath, availableEditors]);

  return (
    <SettingsSection title="About">
      {isElectron ? (
        <AboutVersionSection />
      ) : (
        <SettingsRow
          title={<AboutVersionTitle />}
          description="Current version of the application."
        />
      )}
      <SettingsRow
        title="Diagnostics"
        description={diagnosticsDescription}
        status={
          <>
            <span className="block break-all font-mono text-[11px] text-foreground">
              {logsDirectoryPath ?? "Resolving logs directory..."}
            </span>
            {openDiagnosticsError ? (
              <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
            ) : null}
          </>
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!logsDirectoryPath || isOpeningLogsDirectory}
            onClick={openLogsDirectory}
          >
            {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
