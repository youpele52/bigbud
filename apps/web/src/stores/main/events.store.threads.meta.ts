import { type OrchestrationEvent } from "@bigbud/contracts";

import { normalizeModelSlug } from "./mappers.store";
import { type AppState } from "./main.store";
import { buildLatestTurn, updateThreadState } from "./helpers.store";

export function applyThreadMetaEvent(
  state: AppState,
  event: OrchestrationEvent,
): AppState | undefined {
  switch (event.type) {
    case "thread.deletion-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        deletingAt: event.payload.deletingAt,
        updatedAt: event.payload.deletingAt,
      }));
    }

    case "thread.deletion-failed": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        deletingAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.archived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.unarchived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.meta-updated": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
        ...(event.payload.providerRuntimeExecutionTargetId !== undefined
          ? { providerRuntimeExecutionTargetId: event.payload.providerRuntimeExecutionTargetId }
          : {}),
        ...(event.payload.workspaceExecutionTargetId !== undefined
          ? { workspaceExecutionTargetId: event.payload.workspaceExecutionTargetId }
          : {}),
        ...(event.payload.executionTargetId !== undefined
          ? { executionTargetId: event.payload.executionTargetId }
          : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSlug(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.runtime-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.interaction-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.turn-start-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: normalizeModelSlug(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.turn-interrupt-requested": {
      if (event.payload.turnId === undefined) {
        return state;
      }
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt: event.occurredAt,
        };
      });
    }

    default:
      return undefined;
  }
}
