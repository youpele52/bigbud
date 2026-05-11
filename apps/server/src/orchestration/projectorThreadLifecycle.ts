/**
 * Projector — thread lifecycle event cases.
 *
 * Handles: thread.created, thread.deletion-requested, thread.deletion-failed,
 * thread.deleted, thread.archived, thread.unarchived,
 * thread.meta-updated, thread.runtime-mode-set, thread.interaction-mode-set
 */
import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { OrchestrationThread } from "@bigbud/contracts";
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
  ThreadRuntimeModeSetPayload,
  ThreadUnarchivedPayload,
} from "./Schemas.ts";
import { decodeForEvent, updateThread } from "./projectorHelpers.ts";

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
        modelSelection: payload.modelSelection,
        runtimeMode: payload.runtimeMode,
        interactionMode: payload.interactionMode,
        branch: payload.branch,
        worktreePath: payload.worktreePath,
        latestTurn: null,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
        archivedAt: null,
        deletingAt: null,
        deletedAt: null,
        ...(payload.parentThread !== undefined ? { parentThread: payload.parentThread } : {}),
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

export function projectThreadDeleted(
  nextBase: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.deleted" }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      threads: updateThread(nextBase.threads, payload.threadId, {
        deletingAt: null,
        deletedAt: payload.deletedAt,
        updatedAt: payload.deletedAt,
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
