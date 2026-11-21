import type { OrchestrationEvent, ThreadId } from "@bigbud/contracts";

export function getDeletedThreadIds(
  payload: Extract<OrchestrationEvent, { type: "thread.deleted" }>["payload"],
): readonly ThreadId[] {
  return payload.threadIds ?? [payload.threadId];
}

/**
 * One toast slot for every undone deletion: a repeated or batched failure replaces the visible
 * notice instead of stacking another copy of it.
 */
export const THREAD_DELETION_FAILED_TOAST_ID = "thread-deletion-failed";

const UNKNOWN_REASON = "bigbud kept it after a safety check or cleanup failure.";

/** The server's reason for each undone deletion in a batch; the latest event wins. */
export function getThreadDeletionFailureReasons(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyMap<ThreadId, string | undefined> {
  const reasons = new Map<ThreadId, string | undefined>();
  for (const event of events) {
    if (event.type === "thread.deletion-failed") {
      reasons.set(event.payload.threadId, event.payload.reason);
    }
  }
  return reasons;
}

/** Description for one undone deletion: what blocked it, or a generic note for old events. */
export function describeThreadDeletionFailure(reason: string | undefined): string {
  return reason ?? UNKNOWN_REASON;
}

export function getFailedThreadDeletionToast(
  failures: ReadonlyArray<{ readonly threadId: ThreadId; readonly reason?: string | undefined }>,
): {
  readonly id: string;
  readonly type: "error";
  readonly title: string;
  readonly description: string;
} | null {
  if (failures.length === 0) return null;
  const reasons = new Set(failures.map((failure) => failure.reason));
  const sharedReason = reasons.size === 1 ? failures[0]!.reason : undefined;
  return {
    id: THREAD_DELETION_FAILED_TOAST_ID,
    type: "error",
    title:
      failures.length === 1
        ? "Thread was not deleted"
        : `${failures.length} threads were not deleted`,
    description:
      failures.length === 1 || sharedReason !== undefined
        ? describeThreadDeletionFailure(sharedReason)
        : "bigbud kept them after safety checks or cleanup failures. Open a thread to see why.",
  };
}

/**
 * The toast for a batch's undone deletions, skipping threads whose own surface (a Sidecar that
 * failed to close) already explained the failure: one action shows one toast.
 */
export function getBatchFailedThreadDeletionToast(input: {
  readonly events: ReadonlyArray<OrchestrationEvent>;
  readonly failedThreadIds: ReadonlyArray<ThreadId>;
  readonly alreadyNotifiedThreadIds: ReadonlySet<ThreadId>;
}): ReturnType<typeof getFailedThreadDeletionToast> {
  const reasons = getThreadDeletionFailureReasons(input.events);
  return getFailedThreadDeletionToast(
    input.failedThreadIds
      .filter((threadId) => !input.alreadyNotifiedThreadIds.has(threadId))
      .map((threadId) => ({ threadId, reason: reasons.get(threadId) })),
  );
}
