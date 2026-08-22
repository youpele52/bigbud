/**
 * Projector — thread lifecycle event cases.
 *
 * Handles: thread.created, thread.deletion-requested, thread.deletion-failed,
 * thread.deleted, thread.archived, thread.unarchived,
 * thread.meta-updated, thread.runtime-mode-set, thread.interaction-mode-set
 */
import {
  LOCAL_EXECUTION_TARGET_ID,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  OrchestrationThread,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDeletionFailedPayload,
  ThreadDeletionRequestedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadPinnedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadTurnStartFailedPayload,
  ThreadUnarchivedPayload,
  ThreadUnpinnedPayload,
} from "./Schemas.ts";

import { decodeForEvent, updateThread } from "./projectorHelpers.ts";

function resolveSyncedElevatorSummaryUpdate(input: {
  readonly currentTitle: string;
  readonly currentElevatorSummary: string | null;
  readonly currentElevatorSummaryMessageCount: number;
  readonly nextTitle?: string;
  readonly nextElevatorSummary?: string;
  readonly nextElevatorSummaryMessageCount?: number;
}) {
  if (
    input.nextElevatorSummary !== undefined ||
    input.nextElevatorSummaryMessageCount !== undefined
  ) {
    return {
      ...(input.nextElevatorSummary !== undefined
        ? { elevatorSummary: input.nextElevatorSummary }
        : {}),
      ...(input.nextElevatorSummaryMessageCount !== undefined
        ? { elevatorSummaryMessageCount: input.nextElevatorSummaryMessageCount }
        : {}),
    };
  }
  if (
    input.nextTitle === undefined ||
    input.currentElevatorSummaryMessageCount !== 0 ||
    input.currentElevatorSummary !== input.currentTitle
  ) {
    return {};
  }
  return {
    elevatorSummary: input.nextTitle,
  };
}

export function projectThreadCreated(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.created" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return Effect.gen(function* () {
    const payload = yield* decodeForEvent(
      ThreadCreatedPayload,
      event.payload,
      event.type,
      "payload",
    );
    const thread: OrchestrationThread = yield* decodeForEvent(
      OrchestrationThread,
      {
        id: payload.threadId,
        projectId: payload.projectId,
        title: payload.title,
        purpose: payload.purpose ?? "standard",
        elevatorSummary: payload.title,
        elevatorSummaryMessageCount: 0,
        providerRuntimeExecutionTargetId:
          payload.providerRuntimeExecutionTargetId ??
          payload.executionTargetId ??
          LOCAL_EXECUTION_TARGET_ID,
        workspaceExecutionTargetId:
          payload.workspaceExecutionTargetId ??
          payload.executionTargetId ??
          LOCAL_EXECUTION_TARGET_ID,
        executionTargetId: payload.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
        modelSelection: payload.modelSelection,
        runtimeMode: payload.runtimeMode,
        interactionMode: payload.interactionMode,
        branch: payload.branch,
        worktreePath: payload.worktreePath,
        latestTurn: null,
        queuedPrompts: [],
        pendingInterruptFlushIntent: null,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
        ...(payload.parentThread !== undefined
          ? {
              parentThread: {
                ...payload.parentThread,
                projectId: payload.parentThread.projectId ?? payload.projectId,
              },
            }
          : {}),
        messages: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
      event.type,
      "thread",
    );
    const existing = nextBase.threads.find((entry) => entry.id === thread.id);
    return {
      ...nextBase,
      threads: existing
        ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
        : [...nextBase.threads, thread],
    };
  });
}

export function projectThreadDeletionRequested(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.deletion-requested" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadDeletionRequestedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        deletingAt: payload.deletingAt,
        updatedAt: payload.deletingAt,
      }),
    })),
  );
}

export function projectThreadDeletionFailed(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.deletion-failed" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadDeletionFailedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        deletingAt: null,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadTurnStartFailed(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.turn-start-failed" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadTurnStartFailedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => {
      const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
      if (!thread) {
        return nextBase;
      }

      const session = thread.session
        ? {
            ...thread.session,
            status: "error" as const,
            activeTurnId: null,
            reason: payload.context,
            lastError: payload.detail,
            updatedAt: payload.createdAt,
          }
        : {
            threadId: thread.id,
            status: "error" as const,
            providerName: thread.modelSelection.provider,
            runtimeMode: thread.runtimeMode,
            activeTurnId: null,
            reason: payload.context,
            lastError: payload.detail,
            updatedAt: payload.createdAt,
          };
      const latestTurn = thread.latestTurn
        ? {
            ...thread.latestTurn,
            state: "error" as const,
            startedAt: thread.latestTurn.startedAt ?? payload.createdAt,
            completedAt: thread.latestTurn.completedAt ?? payload.createdAt,
          }
        : null;

      return {
        ...nextBase,
        threads: updateThread(nextBase.threads, payload.threadId, {
          session,
          latestTurn,
          updatedAt: payload.createdAt,
        }),
      };
    }),
  );
}

export function projectThreadDeleted(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.deleted" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => {
      const deletedThreadIds = new Set(payload.threadIds ?? [payload.threadId]);
      return {
        ...nextBase,
        threads: nextBase.threads
          .filter((thread) => !deletedThreadIds.has(thread.id))
          .map((thread) => {
            if (!thread.parentThread || !deletedThreadIds.has(thread.parentThread.threadId)) {
              return thread;
            }
            const { parentThread: _parentThread, ...detachedThread } = thread;
            return detachedThread;
          }),
      };
    }),
  );
}

export function projectThreadPinned(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.pinned" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        pinnedAt: payload.pinnedAt,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadUnpinned(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.unpinned" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        pinnedAt: null,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadArchived(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.archived" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        archivedAt: payload.archivedAt,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadUnarchived(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.unarchived" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        archivedAt: null,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadMetaUpdated(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.meta-updated" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...resolveSyncedElevatorSummaryUpdate({
          currentTitle:
            nextBase.threads.find((entry) => entry.id === payload.threadId)?.title ?? "",
          currentElevatorSummary:
            nextBase.threads.find((entry) => entry.id === payload.threadId)?.elevatorSummary ??
            null,
          currentElevatorSummaryMessageCount:
            nextBase.threads.find((entry) => entry.id === payload.threadId)
              ?.elevatorSummaryMessageCount ?? 0,
          ...(payload.title !== undefined ? { nextTitle: payload.title } : {}),
          ...(payload.elevatorSummary !== undefined
            ? { nextElevatorSummary: payload.elevatorSummary }
            : {}),
          ...(payload.elevatorSummaryMessageCount !== undefined
            ? { nextElevatorSummaryMessageCount: payload.elevatorSummaryMessageCount }
            : {}),
        }),
        ...(payload.providerRuntimeExecutionTargetId !== undefined
          ? { providerRuntimeExecutionTargetId: payload.providerRuntimeExecutionTargetId }
          : {}),
        ...(payload.workspaceExecutionTargetId !== undefined
          ? { workspaceExecutionTargetId: payload.workspaceExecutionTargetId }
          : {}),
        ...(payload.executionTargetId !== undefined
          ? { executionTargetId: payload.executionTargetId }
          : {}),
        ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
        ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
        ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadRuntimeModeSet(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.runtime-mode-set" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        runtimeMode: payload.runtimeMode,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}

export function projectThreadInteractionModeSet(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.interaction-mode-set" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadInteractionModeSetPayload, event.payload, event.type, "payload").pipe(
    // oxlint-disable-next-line no-map-spread -- copy-on-write required for immutable read model
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        interactionMode: payload.interactionMode,
        updatedAt: payload.updatedAt,
      }),
    })),
  );
}
