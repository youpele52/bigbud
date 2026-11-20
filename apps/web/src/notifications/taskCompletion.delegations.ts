import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { USER_TURN_BOUND } from "@bigbud/shared/internalTextGeneration";
import type { Thread } from "../models/types";

/** Acceptance belongs to an exact child/request, never its reserved or latest turn. */
export function observeDelegatedTurnBinding(thread: Thread, event: OrchestrationEvent): Thread {
  if (event.type !== "thread.activity-appended") return thread;
  const activity = event.payload.activity;
  if (activity.kind !== USER_TURN_BOUND || !activity.turnId) return thread;
  const payload = activity.payload as { messageId?: unknown; sessionEpoch?: unknown } | null;
  if (typeof payload?.messageId !== "string" || typeof payload.sessionEpoch !== "number")
    return thread;
  const safety = thread.notificationSafety;
  if (!safety?.childTurns || safety.turnId !== thread.latestTurn?.turnId) return thread;
  let changed = false;
  const childTurns = safety.childTurns.map((link) => {
    if (
      link.threadId !== event.payload.threadId ||
      link.requestMessageId !== payload.messageId ||
      link.turnId != null
    )
      return link;
    // The first accepted startup result is immutable, even if that request is later retried.
    changed = true;
    return { ...link, turnId: activity.turnId, sessionEpoch: payload.sessionEpoch as number };
  });
  return changed
    ? {
        ...thread,
        notificationSafetySequence: Math.max(
          thread.notificationSafetySequence ?? 0,
          event.sequence,
        ),
        notificationSafety: { ...safety, childTurns },
      }
    : thread;
}
