import { useEffect, useRef } from "react";
import type { EventId, OrchestrationThreadActivity, ThreadId } from "@bigbud/contracts";
import { successfulUserTurns } from "@bigbud/shared/internalTextGeneration";
import { readNativeApi } from "~/rpc/nativeApi";
import { toastManager } from "../../../ui/toast";
import { useTextGenerationWarnings } from "../../../../stores/ui/textGenerationWarnings.store";

type Operation = "title" | "summary";
type ToastId = ReturnType<typeof toastManager.add>;
const operations: readonly Operation[] = ["title", "summary"];

function latestGenerationStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  operation: Operation,
) {
  return activities.findLast(
    (activity) =>
      [
        "text-generation.failed",
        "text-generation.completed",
        "text-generation.started",
        "text-generation.uncertain",
      ].includes(activity.kind) &&
      typeof activity.payload === "object" &&
      activity.payload !== null &&
      "operation" in activity.payload &&
      activity.payload.operation === operation,
  );
}

/** Routine metadata failures are transient; uncertain native work is kept in activity history only. */
export function ThreadTextGenerationNotice(props: {
  threadId: ThreadId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}) {
  const owner = useRef(Symbol("text-generation-toast"));
  const shown = useRef(new Map<string, ToastId | null>());
  const pending = useRef(false);

  useEffect(() => {
    const eligible = successfulUserTurns(props.activities).length >= 3;
    for (const operation of operations) {
      const activity = latestGenerationStatus(props.activities, operation);
      const failed =
        eligible &&
        activity?.kind === "text-generation.failed" &&
        (operation === "summary" ||
          (activity.payload as { finalFailure?: boolean }).finalFailure === true);
      const key = JSON.stringify([props.threadId, operation]);
      if (!failed) {
        const toastId = shown.current.get(key);
        if (toastId) toastManager.close(toastId);
        if (shown.current.has(key)) shown.current.set(key, null);
        continue;
      }

      const warnings = useTextGenerationWarnings.getState();
      warnings.claim(key, owner.current);
      if (useTextGenerationWarnings.getState().owners.get(key) !== owner.current) continue;
      if (shown.current.has(key)) continue;

      const retry = async (sourceActivityId: EventId) => {
        const api = readNativeApi();
        if (!api || pending.current) return;
        pending.current = true;
        try {
          await api.server.retryTextGeneration({
            threadId: props.threadId,
            operation,
            sourceActivityId,
          });
          const toastId = shown.current.get(key);
          if (toastId) toastManager.close(toastId);
          shown.current.set(key, null);
        } catch (error) {
          toastManager.add({
            type: "warning",
            title: `Couldn’t retry thread ${operation}`,
            description: error instanceof Error ? error.message : "Text generation is unavailable.",
            data: { threadId: props.threadId },
          });
        } finally {
          pending.current = false;
        }
      };
      shown.current.set(
        key,
        toastManager.add({
          type: "warning",
          title: `Couldn’t generate thread ${operation}`,
          description: "You can retry without resending your message.",
          data: { threadId: props.threadId },
          actionProps: { children: "Retry", onClick: () => void retry(activity.id) },
        }),
      );
    }
  }, [props.activities, props.threadId]);

  return null;
}
