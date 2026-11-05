import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  COPILOT_SETUP_EVENT,
  copilotJobBusy,
  useCopilotRuntime,
} from "../../hooks/useCopilotRuntime";
import { DownloadProgress } from "../common/DownloadProgress";
import { Button } from "../ui/button";
import { CopilotSetupDialog } from "./CopilotSetupDialog";
import { formatBytes } from "../settings/CopilotRuntimeSettings.logic";
import { ensureNativeApi } from "../../rpc/nativeApi";

/** Shares the updater's footer position, not its state or dismissal identity. */
export function SidebarCopilotRuntime() {
  const {
    data: state,
    act,
    refetch,
    dismiss,
    pendingDismissal,
    dataUpdatedAt,
  } = useCopilotRuntime();
  const lastDismissalRetry = useRef(0);
  const navigate = useNavigate();
  const [requested, setRequested] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const request = () => {
      void refetch()
        .then(({ data }) => {
          if (data && data.source !== "missing")
            return navigate({
              href: `/settings/providers?providers=${encodeURIComponent(JSON.stringify(["copilot"]))}`,
            });
          setRequested(true);
        })
        .catch((error) => setError(error instanceof Error ? error.message : String(error)));
    };
    window.addEventListener(COPILOT_SETUP_EVENT, request);
    return () => window.removeEventListener(COPILOT_SETUP_EVENT, request);
  }, [refetch, navigate]);
  const job = state?.job;
  const busy = copilotJobBusy(job?.phase);
  useEffect(() => {
    if (!pendingDismissal || !state?.onboarding) return;
    if (Date.now() - lastDismissalRetry.current < 15_000) return;
    lastDismissalRetry.current = Date.now();
    void dismiss()
      .then(() => setError(null))
      .catch((error) =>
        setError(
          `Could not remember Copilot setup preference: ${error instanceof Error ? error.message : String(error)}. Will retry when connected.`,
        ),
      );
  }, [dismiss, pendingDismissal, state?.onboarding, dataUpdatedAt]);
  useEffect(() => {
    if (job?.phase !== "installed" && job?.phase !== "uninstalled") return;
    void ensureNativeApi()
      .server.refreshProviders()
      .catch((error) => setError(error instanceof Error ? error.message : String(error)));
  }, [job?.id, job?.phase]);
  async function action(action: "cancel" | "install" | "uninstall") {
    try {
      await act({ action, ...(action === "cancel" && job ? { jobId: job.id } : {}) });
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <CopilotSetupDialog
        open={Boolean(
          state &&
          state.source === "missing" &&
          (requested || (state.onboarding && !pendingDismissal)) &&
          !busy,
        )}
        onFailure={setError}
        onClose={() => setRequested(false)}
      />
      {job && (busy || job.id !== dismissed) ? (
        <div data-copilot-runtime-job={job.id} className="space-y-1 text-xs">
          {busy ? (
            <DownloadProgress
              label={`${job.operation === "uninstall" ? "Removing" : job.phase === "downloading" ? "Downloading" : job.phase === "verifying" ? "Verifying" : "Installing"} Copilot`}
              percent={
                job.phase === "downloading" && job.totalBytes
                  ? (100 * job.transferredBytes) / job.totalBytes
                  : null
              }
              detail={
                job.totalBytes
                  ? `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)} download`
                  : undefined
              }
              action={
                job.phase === "downloading" ? (
                  <Button variant="ghost" size="sm" onClick={() => void action("cancel")}>
                    Cancel
                  </Button>
                ) : null
              }
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2 px-2 py-1">
              <span
                className={
                  job.phase === "error"
                    ? "text-destructive"
                    : job.phase === "cancelled"
                      ? "text-warning"
                      : "text-success"
                }
              >
                {job.phase === "installed"
                  ? "Copilot installed"
                  : job.phase === "uninstalled"
                    ? "Managed Copilot removed"
                    : job.phase === "cancelled"
                      ? "Copilot download cancelled"
                      : job.error}
              </span>
              {job.phase === "error" || job.phase === "cancelled" ? (
                <Button variant="ghost" size="sm" onClick={() => void action(job.operation)}>
                  Retry
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={() => setDismissed(job.id)}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
