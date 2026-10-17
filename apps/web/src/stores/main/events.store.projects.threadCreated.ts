import type { OrchestrationEvent } from "@bigbud/contracts";

import { mapThread } from "./mappers.store";

export function mapCreatedProjectThread(
  event: Extract<OrchestrationEvent, { type: "thread.created" }>,
) {
  return mapThread({
    id: event.payload.threadId,
    projectId: event.payload.projectId,
    title: event.payload.title,
    purpose: event.payload.purpose ?? "standard",
    elevatorSummary: event.payload.title,
    elevatorSummaryMessageCount: 0,
    providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId,
    executionTargetId: event.payload.executionTargetId,
    modelSelection: event.payload.modelSelection,
    runtimeMode: event.payload.runtimeMode,
    interactionMode: event.payload.interactionMode,
    branch: event.payload.branch,
    worktreePath: event.payload.worktreePath,
    ...(event.payload.parentThread ? { parentThread: event.payload.parentThread } : {}),
    ...(event.payload.forkOrigin ? { forkOrigin: event.payload.forkOrigin } : {}),
    // A fork holding the source's uncertain message starts with its queue held.
    queueHold: event.payload.forkOrigin?.pendingDelivery === "held",
    latestTurn: null,
    createdAt: event.payload.createdAt,
    updatedAt: event.payload.updatedAt,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  });
}
