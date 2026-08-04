/**
 * Threads projector — handles thread lifecycle events.
 *
 * @module ProjectionPipeline.projector.threads
 */
import { LOCAL_EXECUTION_TARGET_ID, type OrchestrationEvent } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";
import { advancesThreadActivityAt } from "./ProjectionPipeline.projector.projects.lastUsed.ts";

function resolveSyncedElevatorSummary(input: {
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

export function makeThreadsProjector(
  deps: Pick<ProjectorDeps, "projectionThreadRepository">,
): ProjectorDefinition {
  const { projectionThreadRepository } = deps;

  const apply = Effect.fn("applyThreadsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    if (event.type !== "thread.created" && advancesThreadActivityAt(event)) {
      yield* projectionThreadRepository.touchActivity({
        threadId: event.payload.threadId,
        occurredAt: event.occurredAt,
      });
    }
    switch (event.type) {
      case "thread.created":
        yield* projectionThreadRepository.upsert({
          threadId: event.payload.threadId,
          projectId: event.payload.projectId,
          title: event.payload.title,
          purpose: event.payload.purpose ?? "standard",
          elevatorSummary: event.payload.title,
          elevatorSummaryMessageCount: 0,
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
          queuedPrompts: [],
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          lastActivityAt: event.payload.updatedAt,
          archivedAt: null,
          pinnedAt: null,
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

      case "thread.pinned": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) return;
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          pinnedAt: event.payload.pinnedAt,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.unpinned": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) return;
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          pinnedAt: null,
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
          ...resolveSyncedElevatorSummary({
            currentTitle: existingRow.value.title,
            currentElevatorSummary: existingRow.value.elevatorSummary,
            currentElevatorSummaryMessageCount: existingRow.value.elevatorSummaryMessageCount,
            ...(event.payload.title !== undefined ? { nextTitle: event.payload.title } : {}),
            ...(event.payload.elevatorSummary !== undefined
              ? { nextElevatorSummary: event.payload.elevatorSummary }
              : {}),
            ...(event.payload.elevatorSummaryMessageCount !== undefined
              ? { nextElevatorSummaryMessageCount: event.payload.elevatorSummaryMessageCount }
              : {}),
          }),
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
        yield* projectionThreadRepository.deleteById({
          threadId: event.payload.threadId,
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

      case "thread.prompt-queued":
      case "thread.queued-prompt-removed":
      case "thread.queued-prompts-flushed": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) return;
        const current = existingRow.value.queuedPrompts;
        const queuedPrompts =
          event.type === "thread.prompt-queued"
            ? current.some((prompt) => prompt.id === event.payload.prompt.id)
              ? current
              : [...current, event.payload.prompt]
            : event.type === "thread.queued-prompt-removed"
              ? current.filter((prompt) => prompt.id !== event.payload.messageId)
              : current.filter((prompt) => !event.payload.messageIds.includes(prompt.id));
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          queuedPrompts,
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

      case "thread.turn-start-failed": {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionThreadRepository.upsert({
          ...existingRow.value,
          latestTurnId: null,
          updatedAt: event.payload.createdAt,
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
