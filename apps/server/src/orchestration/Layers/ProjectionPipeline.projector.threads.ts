/**
 * Threads projector — handles thread lifecycle events.
 *
 * @module ProjectionPipeline.projector.threads
 */
import { LOCAL_EXECUTION_TARGET_ID, type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadsProjector(
  deps: Pick<ProjectorDeps, "projectionThreadRepository">,
): ProjectorDefinition {
  const { projectionThreadRepository } = deps;

  const apply = Effect.fn("applyThreadsProjection")(function* (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.created":
        yield* projectionThreadRepository.upsert({
          threadId: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          providerRuntimeExecutionTargetId:
            event.payload.providerRuntimeExecutionTargetId ??
            event.payload.executionTargetId ??
            LOCAL_EXECUTION_TARGET_ID,
          workspaceExecutionTargetId:
            event.payload.workspaceExecutionTargetId ??
            event.payload.executionTargetId ??
            LOCAL_EXECUTION_TARGET_ID,
          executionTargetId: event.payload.executionTargetId ?? LOCAL_EXECUTION_TARGET_ID,
          modelSelection: event.payload.modelSelection,
          runtimeMode: event.payload.runtimeMode,
          interactionMode: event.payload.interactionMode,
          branch: event.payload.branch,
          worktreePath: event.payload.worktreePath,
          ...(event.payload.parentThread !== undefined
            ? { parentThread: event.payload.parentThread }
            : {}),
          latestTurnId: null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          archivedAt: null,
          deletingAt: null,
          deletedAt: null,
        });
        return;

      case "thread.deletion-requested": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          deletingAt: event.payload.deletingAt,
          updatedAt: event.payload.deletingAt,
        });
        return;
      }

      case "thread.deletion-failed": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          deletingAt: null,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.archived": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          archivedAt: event.payload.archivedAt,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.unarchived": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          archivedAt: null,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.meta-updated": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
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
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
          ...(event.payload.worktreePath !== undefined
            ? { worktreePath: event.payload.worktreePath }
            : {}),
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.runtime-mode-set": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          runtimeMode: event.payload.runtimeMode,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.interaction-mode-set": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          interactionMode: event.payload.interactionMode,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.deleted": {
        attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          deletingAt: null,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        });
        return;
      }

      case "thread.message-sent":
      case "thread.proposed-plan-upserted":
      case "thread.activity-appended": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          updatedAt: event.occurredAt,
        });
        return;
      }

      case "thread.session-set": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          latestTurnId: event.payload.session.activeTurnId,
          updatedAt: event.occurredAt,
        });
        return;
      }

      case "thread.turn-diff-completed": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          latestTurnId: event.payload.turnId,
          updatedAt: event.occurredAt,
        });
        return;
      }

      case "thread.reverted": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          latestTurnId: null,
          updatedAt: event.occurredAt,
        });
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threads, apply };
}
