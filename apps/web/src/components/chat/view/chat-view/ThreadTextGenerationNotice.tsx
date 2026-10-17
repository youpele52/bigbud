import { useState } from "react";
import type { EventId, OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { readNativeApi } from "~/rpc/nativeApi";
import { Button } from "../../../ui/button";
import { toastManager } from "../../../ui/toast";

/** Metadata failures are nonblocking and never require resending a conversation message. */
export function ThreadTextGenerationNotice(props: {
  threadId: ThreadId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const notices = (["title", "summary"] as const).flatMap((operation) => {
    const activity = props.activities.findLast(
      (item) =>
        ["text-generation.failed", "text-generation.completed", "text-generation.started"].includes(
          item.kind,
        ) &&
        typeof item.payload === "object" &&
        item.payload !== null &&
        "operation" in item.payload &&
        item.payload.operation === operation,
    );
    return activity && activity.kind !== "text-generation.completed"
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
    <div className="shrink-0 space-y-1 px-3 py-1" aria-live="polite">
      {notices.map(({ operation, activity }) => (
        <div
          key={operation}
          role="status"
          className={`flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs ${activity.kind === "text-generation.failed" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"}`}
        >
          <span>{activity.summary}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={pending !== null}
            onClick={() => void retry(operation, activity.id)}
          >
            {pending === operation ? "Requesting…" : "Retry"}
          </Button>
        </div>
      ))}
    </div>
  );
}
