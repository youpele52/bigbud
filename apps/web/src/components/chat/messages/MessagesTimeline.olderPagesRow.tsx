import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import type { OlderPagesStatus } from "./MessagesTimeline.olderPages";

/**
 * Small inline top loader and retry row for older message pages. It overlays the top of the
 * timeline from a zero-height wrapper, so showing or hiding it never shifts the rows below.
 */
export function OlderMessagesStatusRow(props: {
  readonly status: OlderPagesStatus;
  readonly onRetry: () => void;
}) {
  if (props.status !== "loading" && props.status !== "error") return null;
  return (
    <div className="relative h-0" data-older-messages-status={props.status}>
      <div className="absolute inset-x-0 top-1 z-10 flex justify-center">
        <div
          role={props.status === "error" ? "alert" : undefined}
          className="flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-xs"
        >
          {props.status === "loading" ? (
            <>
              <Spinner className="size-3" />
              <span>Loading older messages</span>
            </>
          ) : (
            <>
              <span>Couldn't load older messages.</span>
              <Button size="xs" variant="ghost" className="text-xs" onClick={props.onRetry}>
                Retry
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
