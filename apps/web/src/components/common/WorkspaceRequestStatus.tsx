import {
  workspaceErrorDetails,
  workspaceErrorSummary,
} from "../../lib/workspaceRequestRecovery.errors";
import { BigbudLogo } from "../sidebar/SidebarProjectItem";
import { Button } from "../ui/button";

interface WorkspaceRequestStatusProps {
  readonly error?: string | null | undefined;
  readonly recovering?: boolean | undefined;
  readonly pending?: boolean | undefined;
  readonly onRetry?: (() => void) | undefined;
}

export function WorkspaceRequestStatus({
  error,
  recovering,
  pending,
  onRetry,
}: WorkspaceRequestStatusProps) {
  if (!error) {
    return (
      <div
        className="flex w-full items-center justify-center px-2 py-3 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <BigbudLogo
          decorative
          className="h-4 shrink-0 animate-pulse-slow motion-reduce:animate-none"
        />
        <span className="sr-only">
          {recovering ? "Reconnecting to workspace…" : "Loading files…"}
        </span>
      </div>
    );
  }
  const details = workspaceErrorDetails(error);
  return (
    <div className="space-y-2 px-2 py-3 text-xs" role="alert">
      <div className="text-destructive">{workspaceErrorSummary(error)}</div>
      <Button variant="outline" size="sm" disabled={pending} onClick={onRetry}>
        {pending ? "Waiting for connection…" : "Retry"}
      </Button>
      {details ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
