/**
 * Projects projector — handles project lifecycle events.
 *
 * @module ProjectionPipeline.projector.projects
 */
import { Effect, Option } from "effect";
import { LOCAL_EXECUTION_TARGET_ID, type OrchestrationEvent } from "@bigbud/contracts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import type { ProjectorDefinition, ProjectorDeps } from "./ProjectionPipeline.projectors.ts";
import { advancesProjectLastUsedAt } from "./ProjectionPipeline.projector.projects.lastUsed.ts";

export function makeProjectsProjector(
  deps: Pick<
    ProjectorDeps,
    "findThreadProjectId" | "projectionProjectRepository" | "projectionThreadRepository"
  >,
): ProjectorDefinition {
  const { findThreadProjectId, projectionProjectRepository, projectionThreadRepository } = deps;

  const apply = Effect.fn("applyProjectsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    if (advancesProjectLastUsedAt(event)) {
      if (event.type === "thread.created") {
        yield* projectionProjectRepository.touchLastUsedAt({
          projectId: event.payload.projectId,
          lastUsedAt: event.occurredAt,
        });
      } else {
        const thread = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        const projectId = Option.isSome(thread)
          ? thread.value.projectId
          : Option.getOrUndefined(yield* findThreadProjectId(event.payload.threadId));
        if (projectId !== undefined) {
          yield* projectionProjectRepository.touchLastUsedAt({
            projectId,
            lastUsedAt: event.occurredAt,
          });
        }
      }
    }
    switch (event.type) {
      case "project.created":
        yield* projectionProjectRepository.upsert({
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
          workspaceRoot: event.payload.workspaceRoot,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletingAt: null,
          deletedAt: null,
        });
        yield* projectionProjectRepository.touchLastUsedAt({
          projectId: event.payload.projectId,
          lastUsedAt: event.payload.updatedAt,
        });
        return;

      case "project.meta-updated": {
        const existingRow = yield* projectionProjectRepository.getById({
          projectId: event.payload.projectId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionProjectRepository.upsert({
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
          ...(event.payload.workspaceRoot !== undefined
            ? { workspaceRoot: event.payload.workspaceRoot }
            : {}),
          ...(event.payload.defaultModelSelection !== undefined
            ? { defaultModelSelection: event.payload.defaultModelSelection }
            : {}),
          ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
          updatedAt: event.payload.updatedAt,
        });
        yield* projectionProjectRepository.touchLastUsedAt({
          projectId: event.payload.projectId,
          lastUsedAt: event.payload.updatedAt,
        });
        return;
      }

      case "project.deletion-requested": {
        const existingRow = yield* projectionProjectRepository.getById({
          projectId: event.payload.projectId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionProjectRepository.upsert({
          ...existingRow.value,
          deletingAt: event.payload.deletingAt,
          updatedAt: event.payload.deletingAt,
        });
        return;
      }

      case "project.deletion-failed": {
        const existingRow = yield* projectionProjectRepository.getById({
          projectId: event.payload.projectId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionProjectRepository.upsert({
          ...existingRow.value,
          deletingAt: null,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "project.deleted": {
        yield* projectionProjectRepository.deleteById({
          projectId: event.payload.projectId,
        });
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.projects, apply };
}
