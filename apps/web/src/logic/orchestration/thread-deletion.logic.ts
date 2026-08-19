import type { OrchestrationEvent, ThreadId } from "@bigbud/contracts";

export function getDeletedThreadIds(
  payload: Extract<OrchestrationEvent, { type: "thread.deleted" }>["payload"],
): readonly ThreadId[] {
  return payload.threadIds ?? [payload.threadId];
}

export function getFailedThreadDeletionToast(count: number): {
  readonly type: "error";
  readonly title: string;
  readonly description: string;
} | null {
  if (count <= 0) return null;
  return {
    type: "error",
    title: count === 1 ? "Thread was not deleted" : `${count} threads were not deleted`,
    description:
      "bigbud restored them after a safety check or cleanup failure. They are still in the sidebar.",
  };
}
