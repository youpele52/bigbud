import { useEffect, useState } from "react";
import { useCopilotRuntime, copilotJobBusy } from "../../hooks/useCopilotRuntime";
import { Button } from "../ui/button";
import { formatBytes } from "./CopilotRuntimeSettings.logic";

/** Custom executable edits remain server settings; uninstall only addresses managed copies. */
export function CopilotRuntimeSettings({
  customPath,
  onClearPath,
}: {
  customPath: string;
  onClearPath: () => void;
}) {
  const { data: state, act, refetch, error: queryError } = useCopilotRuntime();
  useEffect(() => {
    void refetch();
  }, [customPath, refetch]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = working || copilotJobBusy(state?.job?.phase);
  async function run(action: "install" | "update" | "uninstall" | "cancel") {
    if (
      action === "uninstall" &&
      !window.confirm(
        "Remove bigbud-managed Copilot runtime files? Chats, settings, authentication, and external installations will be preserved.",
      )
    )
      return;
    setWorking(true);
    setError(null);
    try {
      await act({ action, ...(action === "cancel" && state?.job ? { jobId: state.job.id } : {}) });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="space-y-2 border-t border-border/60 px-4 py-3 text-sm sm:px-5">
      <p className="font-medium">Copilot runtime</p>
      {state ? (
        <>
          <p className="break-all text-xs text-muted-foreground">
            {state.available ? `Available · ${state.source}` : "Not available"}
            {state.version ? ` · ${state.version}` : ""}
            {state.installedSizeBytes !== null
              ? ` · ${formatBytes(state.installedSizeBytes)} installed`
              : ""}
            {state.path ? ` · ${state.path}` : ""}
          </p>
          {state.managed.map((runtime) => (
            <p key={runtime.directory} className="break-all text-xs text-muted-foreground">
              Managed {runtime.version} · {formatBytes(runtime.sizeBytes)} installed ·{" "}
              {runtime.directory}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {state.job?.phase === "downloading" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={working}
                onClick={() => void run("cancel")}
              >
                Cancel download
              </Button>
            ) : null}
            {state.job?.phase === "error" || state.job?.phase === "cancelled" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(state.job!.operation)}
              >
                Retry runtime operation
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(state.managed.length ? "update" : "install")}
            >
              {state.managed.length
                ? `Update (${state.pinnedVersion})`
                : state.source !== "missing"
                  ? "Install managed copy"
                  : "Install Copilot"}
            </Button>
            {state.managed.length ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || state.activeLeases > 0}
                onClick={() => void run("uninstall")}
              >
                Uninstall managed runtime
              </Button>
            ) : null}
            {customPath && customPath !== "copilot" ? (
              <Button variant="outline" size="sm" onClick={onClearPath}>
                Clear custom path
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            External and bundled installations are never deleted here. Custom paths can only be
            cleared. Runtime downloads appear beside app downloads in the sidebar.
          </p>
          {state.diagnostic ? <p className="text-xs text-warning">{state.diagnostic}</p> : null}
          {state.activeLeases > 0 ? (
            <p className="text-xs text-warning">
              Stop active Copilot sessions and requests before uninstalling.
            </p>
          ) : null}
          {state.job ? (
            <p className="text-xs text-muted-foreground">
              Runtime operation: {state.job.phase}
              {state.job.totalBytes > 0
                ? ` · ${formatBytes(state.job.transferredBytes)} / ${formatBytes(state.job.totalBytes)} download`
                : ""}
              {state.job.error ? ` · ${state.job.error}` : ""}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {queryError
            ? "Could not load runtime status. Check the server connection."
            : "Checking runtime status…"}
        </p>
      )}
      {error || state?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? state?.error}
        </p>
      ) : null}
    </div>
  );
}
