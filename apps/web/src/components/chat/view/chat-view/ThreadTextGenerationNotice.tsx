import { useState } from "react";
import type { EventId, OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { readNativeApi } from "~/rpc/nativeApi";
import { Button } from "../../../ui/button";
import { toastManager } from "../../../ui/toast";
import { successfulUserTurns } from "@bigbud/shared/internalTextGeneration";
import { ThreadTextGenerationWarning } from "./ThreadTextGenerationWarning";

/** Metadata failures are nonblocking and never require resending a conversation message. */
export function ThreadTextGenerationNotice(props: {
  threadId: ThreadId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const eligible = successfulUserTurns(props.activities).length >= 3;
  const notices = (["title", "summary"] as const).flatMap((operation) => {
    const activity = props.activities.findLast(
      (item) =>
        [
          "text-generation.failed",
          "text-generation.completed",
          "text-generation.started",
          "text-generation.uncertain",
        ].includes(item.kind) &&
        typeof item.payload === "object" &&
        item.payload !== null &&
        "operation" in item.payload &&
        item.payload.operation === operation,
    );
    return activity?.kind === "text-generation.uncertain" ||
      (eligible &&
        activity?.kind === "text-generation.failed" &&
        (operation === "summary" ||
          (activity.payload as { finalFailure?: boolean }).finalFailure === true))
      ? [{ operation, activity }]
      : [];
  });
  if (notices.length === 0) return null;
  const retry = async (operation: "title" | "summary", sourceActivityId: EventId) => {
    const api = readNativeApi();
    if (!api || pending) return;
    setPending(operation);
    try {
      await api.server.retryTextGeneration({
        threadId: props.threadId,
        operation,
        sourceActivityId,
      });
    } catch (error) {
      toastManager.add({
        type: "warning",
        title: `Couldn’t retry thread ${operation}`,
        description: error instanceof Error ? error.message : "Text generation is unavailable.",
      });
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="shrink-0" aria-live="polite">
      {notices.map(({ operation, activity }) => (
        <ThreadTextGenerationWarning
          key={operation}
          threadId={props.threadId}
          operation={operation}
          role="status"
          variant="warning"
          description={activity.summary}
          dismissLabel={`Dismiss thread ${operation} generation notice`}
          action={
            activity.kind === "text-generation.uncertain" ? null : (
              <Button
                size="xs"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => void retry(operation, activity.id)}
              >
                {pending === operation ? "Requesting…" : "Retry"}
              </Button>
            )
          }
        />
      ))}
    </div>
  );
}
