import { dismissUnconfirmedTerminalPane } from "./terminalLifecycle.dismiss";
import { LoaderCircle } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { useTerminalLifecycle } from "../../stores/terminal/terminalLifecycle.store";

export function TerminalLifecycleLabel({
  threadId,
  terminalId,
}: {
  threadId: string;
  terminalId: string;
}) {
  const operation = useTerminalLifecycle(threadId, terminalId);
  if (!operation) return null;
  return (
    <span className="ml-1 text-xs" role="status">
      {operation.phase === "error"
        ? "Needs attention"
        : operation.phase === "closing"
          ? "Closing…"
          : operation.phase === "starting"
            ? "Starting…"
            : "Stopping…"}
    </span>
  );
}

export function TerminalLifecycleStatus({
  threadId,
  terminalId,
  retryClose,
  retryRestart,
}: {
  threadId: string;
  terminalId: string;
  retryClose: () => void;
  retryRestart: () => void;
}) {
  const operation = useTerminalLifecycle(threadId, terminalId);
  if (!operation) return null;
  const failed = operation.phase === "error";
  return (
    <div
      className={cn(
        "absolute z-10 flex items-center gap-2 rounded border bg-background/95 px-2 py-1 text-sm shadow-sm",
        !failed
          ? "left-1/2 top-1/2 w-max max-w-[calc(100%-0.5rem)] -translate-x-1/2 -translate-y-1/2"
          : "inset-x-1 top-1",
      )}
      role={failed ? "alert" : "status"}
    >
      {!failed && <LoaderCircle className="size-3 animate-spin text-blue-500" />}
      <span className={failed ? "min-w-0 flex-1 text-destructive" : "min-w-0 flex-1"}>
        {failed
          ? operation.error
          : operation.phase === "closing"
            ? "Closing terminal…"
            : operation.phase === "starting"
              ? "Starting terminal…"
              : "Stopping terminal…"}
      </span>
      {failed && operation.canDismiss && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            The remote process may still be running. Dismiss only hides this pane.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => dismissUnconfirmedTerminalPane(threadId, terminalId)}
          >
            Dismiss pane
          </Button>
        </div>
      )}
      {failed && !operation.canDismiss && (
        <Button
          size="sm"
          variant="outline"
          onClick={operation.kind === "close" ? retryClose : retryRestart}
        >
          Retry {operation.kind === "close" ? "close" : "restart"}
        </Button>
      )}
    </div>
  );
}
