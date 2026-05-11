import type { OrchestrationEvent, ProjectId, ThreadId } from "@bigbud/contracts";

export interface OrchestrationBatchEffects {
  clearPromotedDraftThreadIds: ThreadId[];
  clearDeletedThreadIds: ThreadId[];
  clearDeletedProjectIds: ProjectId[];
  removeSelectedThreadIds: ThreadId[];
  removeTerminalStateThreadIds: ThreadId[];
  needsProviderInvalidation: boolean;
}

export function deriveOrchestrationBatchEffects(
  events: readonly OrchestrationEvent[],
): OrchestrationBatchEffects {
  const threadLifecycleEffects = new Map<
    ThreadId,
    {
      clearPromotedDraft: boolean;
      clearDeletedThread: boolean;
      removeTerminalState: boolean;
    }
  >();
  let needsProviderInvalidation = false;

  for (const event of events) {
    switch (event.type) {
      case "thread.turn-diff-completed":
      case "thread.reverted": {
        needsProviderInvalidation = true;
        break;
      }

      case "thread.created": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: true,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      case "thread.deleted": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: true,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.archived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.unarchived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      default: {
        break;
      }
    }
  }

  const clearPromotedDraftThreadIds: ThreadId[] = [];
  const clearDeletedThreadIds: ThreadId[] = [];
  const clearDeletedProjectIds: ProjectId[] = [];
  const removeSelectedThreadIds: ThreadId[] = [];
  const removeTerminalStateThreadIds: ThreadId[] = [];
  for (const event of events) {
    if (event.type === "project.deleted") {
      clearDeletedProjectIds.push(event.payload.projectId);
    }
  }
  for (const [threadId, effect] of threadLifecycleEffects) {
    if (effect.clearPromotedDraft) {
      clearPromotedDraftThreadIds.push(threadId);
    }
    if (effect.clearDeletedThread) {
      clearDeletedThreadIds.push(threadId);
      removeSelectedThreadIds.push(threadId);
    }
    if (effect.removeTerminalState) {
      removeTerminalStateThreadIds.push(threadId);
    }
  }

  return {
    clearPromotedDraftThreadIds,
    clearDeletedThreadIds,
    clearDeletedProjectIds,
    removeSelectedThreadIds,
    removeTerminalStateThreadIds,
    needsProviderInvalidation,
  };
}
