import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { isThreadTitleLocked } from "./ThreadTitleLock.ts";

export const TERMINAL_TITLE_COMMAND_PREFIX = "server:terminal-task-title:";
export const TITLE_OWNERSHIP_ACTIVITY = "thread.title-ownership";
export type ThreadTitleOwner = "chat" | "terminal" | "manual";

/** Ownership is stored in the existing durable activity projection, not process-local state. */
export function threadTitleOwner(thread: OrchestrationThread): ThreadTitleOwner | null {
  const activity = thread.activities.findLast((item) => item.kind === TITLE_OWNERSHIP_ACTIVITY);
  const payload = activity?.payload;
  if (!payload || typeof payload !== "object" || !("source" in payload)) return null;
  return payload.source === "chat" || payload.source === "terminal" || payload.source === "manual"
    ? payload.source
    : null;
}

/** Keep the single ownership record when ordinary activity history rolls over. */
export function retainThreadTitleOwnership(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const owner = activities.findLast((item) => item.kind === TITLE_OWNERSHIP_ACTIVITY);
  const tail = activities.slice(-500);
  return owner && !tail.includes(owner) ? [owner, ...tail.slice(-499)] : tail;
}

/** A submitted prompt is meaningful chat evidence even before its provider finishes. */
export function canNameThreadFromTerminal(thread: OrchestrationThread): boolean {
  return (
    !thread.archivedAt &&
    !thread.deletingAt &&
    !thread.deletedAt &&
    threadTitleOwner(thread) === null &&
    !isThreadTitleLocked(thread.id) &&
    /^(?:New thread|New chat)$/.test(thread.title.trim()) &&
    !(thread.queuedPrompts ?? []).some(
      (prompt) => prompt.text.trim().length > 0 || (prompt.attachments?.length ?? 0) > 0,
    ) &&
    !thread.messages.some(
      (message) =>
        message.role === "user" &&
        (message.text.trim().length > 0 || (message.attachments?.length ?? 0) > 0),
    )
  );
}
