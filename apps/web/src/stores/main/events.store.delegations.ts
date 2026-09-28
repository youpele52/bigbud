import type { OrchestrationThreadActivity } from "@bigbud/contracts";

import type { Thread } from "../../models/types";

export function applyDelegationLinkedActivity(
  thread: Thread,
  activity: OrchestrationThreadActivity,
): Thread {
  if (activity.kind !== "delegation.child-linked") return thread;
  const payload = activity.payload as Record<string, unknown>;
  if (
    typeof payload.childThreadId !== "string" ||
    typeof payload.childProjectId !== "string" ||
    typeof payload.childTitle !== "string"
  ) {
    return thread;
  }
  const child = {
    threadId: payload.childThreadId as never,
    projectId: payload.childProjectId as never,
    title: payload.childTitle,
    workflowState: "idle" as const,
    updatedAt: activity.createdAt,
  };
  return {
    ...thread,
    delegatedChildren: [
      child,
      ...(thread.delegatedChildren ?? []).filter((item) => item.threadId !== child.threadId),
    ],
  };
}

export function removeDeletedDelegatedChildren(thread: Thread, deletedIds: ReadonlySet<string>) {
  if (!thread.delegatedChildren?.some((item) => deletedIds.has(item.threadId))) return thread;
  return {
    ...thread,
    delegatedChildren: thread.delegatedChildren.filter((item) => !deletedIds.has(item.threadId)),
  };
}
