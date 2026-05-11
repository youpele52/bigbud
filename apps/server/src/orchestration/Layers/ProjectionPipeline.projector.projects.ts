/**
 * Projects projector — handles project lifecycle events.
 *
 * @module ProjectionPipeline.projector.projects
 */
import { Effect, Option } from "effect";
import type { OrchestrationEvent } from "@bigbud/contracts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import type { ProjectorDefinition, ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeProjectsProjector(
  deps: Pick<ProjectorDeps, "projectionProjectRepository">,
): ProjectorDefinition {
  const { projectionProjectRepository } = deps;

  const apply = Effect.fn("applyProjectsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "project.created":
        yield* projectionProjectRepository.upsert({
          projectId: event.payload.projectId,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
          deletingAt: null,
          deletedAt: null,
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
          ...(event.payload.workspaceRoot !== undefined
            ? { workspaceRoot: event.payload.workspaceRoot }
            : {}),
          ...(event.payload.defaultModelSelection !== undefined
            ? { defaultModelSelection: event.payload.defaultModelSelection }
            : {}),
          ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
          updatedAt: event.payload.updatedAt,
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
        const existingRow = yield* projectionProjectRepository.getById({
          projectId: event.payload.projectId,
        });
        if (Option.isNone(existingRow)) {
          return;
        }
        yield* projectionProjectRepository.upsert({
          ...existingRow.value,
          deletingAt: null,
          deletedAt: event.payload.deletedAt,
          updatedAt: event.payload.deletedAt,
        });
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.projects, apply };
}
