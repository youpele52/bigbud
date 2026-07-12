import { DownloadIcon, InfoIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { isElectron } from "../../config/env";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../../lib/desktopUpdateReactQuery";
import { toastManager } from "../ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  isUnsignedBuildBlocked,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "../layout/desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  Progress,
  ProgressIndicator,
  ProgressLabel,
  ProgressTrack,
  ProgressValue,
} from "../ui/progress";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DOWNLOAD_PREVIEW_QUERY_PARAM = "previewUpdate";

const downloadPreviewState = {
  enabled: true,
  status: "downloading" as const,
  currentVersion: "0.0.0",
  platform: "darwin" as const,
  hostArch: "arm64" as const,
  appArch: "arm64" as const,
  runningUnderArm64Translation: false,
  isCodeSigned: true,
  availableVersion: "0.18.0",
  downloadedVersion: null,
  downloadPercent: 53,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function isDownloadingPreviewEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get(DOWNLOAD_PREVIEW_QUERY_PARAM) === "downloading"
  );
}

export function SidebarUpdatePill() {
  const queryClient = useQueryClient();
  const isDownloadingPreview = isDownloadingPreviewEnabled();
  const queriedState = useDesktopUpdateState().data ?? null;
  const state = isDownloadingPreview ? downloadPreviewState : queriedState;
  const [dismissed, setDismissed] = useState(false);

  const visible =
    (isDownloadingPreview || (isElectron && !import.meta.env.DEV)) &&
    shouldShowDesktopUpdateButton(state) &&
    !dismissed;
  const tooltip = state ? getDesktopUpdateButtonTooltip(state) : "Update available";
  const disabled = isDesktopUpdateButtonDisabled(state);
  const action = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const downloadPercent = Math.round(Math.min(100, Math.max(0, state?.downloadPercent ?? 0)));

  const showArm64Warning = isElectron && shouldShowArm64IntelBuildWarning(state);
  const arm64Description =
    state && showArm64Warning ? getArm64IntelBuildWarningDescription(state) : null;
  const unsignedBlocked = isElectron && state !== null && isUnsignedBuildBlocked(state);

  const handleAction = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    if (disabled || action === "none") return;

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
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

    if (action === "install") {
      const confirmed = window.confirm(getDesktopUpdateInstallConfirmationMessage(state));
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
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
  }, [action, disabled, queryClient, state]);

  if (!visible && !showArm64Warning) return null;

  return (
    <div className="flex flex-col gap-1">
      {showArm64Warning && arm64Description && (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8 text-xs">
          <TriangleAlertIcon />
          <AlertTitle>Intel build on Apple Silicon</AlertTitle>
          <AlertDescription>{arm64Description}</AlertDescription>
        </Alert>
      )}
      {visible && (
        <div className="group/update relative w-full text-xs">
          {state?.status === "downloading" ? (
            <Progress
              aria-label="Downloading update"
              aria-valuetext={`Download progress: ${downloadPercent}%`}
              value={state.downloadPercent}
              className="gap-1.5 px-2 py-1"
            >
              <div className="flex items-center gap-2">
                <DownloadIcon
                  className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} animate-breathe text-info`}
                />
                <ProgressLabel className="text-muted-foreground transition-colors group-hover/update:text-foreground group-focus-within/update:text-foreground">
                  Downloading update
                </ProgressLabel>
                <ProgressValue className="ml-auto transition-colors group-hover/update:text-foreground group-focus-within/update:text-foreground">
                  {(_, value) => (value === null ? "…" : `${Math.round(value)}%`)}
                </ProgressValue>
              </div>
              <ProgressTrack>
                <ProgressIndicator className="bg-info" />
              </ProgressTrack>
            </Progress>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={tooltip}
                    aria-disabled={disabled || undefined}
                    disabled={disabled}
                    className="flex h-7 w-full items-center gap-2 px-2 text-muted-foreground enabled:cursor-pointer enabled:hover:text-foreground enabled:focus-visible:text-foreground enabled:active:text-foreground"
                    onClick={handleAction}
                  >
                    {action === "install" ? (
                      <>
                        <RotateCwIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
                        <span>Restart to update</span>
                        {unsignedBlocked && (
                          <InfoIcon
                            className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} text-primary/70`}
                          />
                        )}
                      </>
                    ) : (
                      <>
                        <DownloadIcon
                          className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} animate-breathe text-info`}
                        />
                        <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 group-hover/update:max-w-28 group-hover/update:opacity-100 focus-visible:max-w-28 focus-visible:opacity-100">
                          Update available
                        </span>
                      </>
                    )}
                  </button>
                }
              />
              <TooltipPopup side="top">{tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {action === "download" && state?.status !== "downloading" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Dismiss update"
                    className="absolute top-1 right-0 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground/65 opacity-0 transition-[color,opacity] hover:text-foreground group-hover/update:opacity-100 focus-visible:opacity-100"
                    onClick={() => setDismissed(true)}
                  >
                    <XIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
                  </button>
                }
              />
              <TooltipPopup side="top">Dismiss until next launch</TooltipPopup>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
