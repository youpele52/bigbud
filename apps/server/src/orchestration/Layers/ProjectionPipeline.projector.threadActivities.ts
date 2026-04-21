/**
 * ThreadActivities projector — handles activity appends and reverts.
 *
 * @module ProjectionPipeline.projector.threadActivities
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
  retainProjectionActivitiesAfterRevert,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadActivitiesProjector(
  deps: Pick<ProjectorDeps, "projectionThreadActivityRepository" | "projectionTurnRepository">,
): ProjectorDefinition {
  const { projectionThreadActivityRepository, projectionTurnRepository } = deps;

  const apply = Effect.fn("applyThreadActivitiesProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.activity-appended":
        yield* projectionThreadActivityRepository.upsert({
          activityId: event.payload.activity.id,
          threadId: event.payload.threadId,
          turnId: event.payload.activity.turnId,
          tone: event.payload.activity.tone,
          kind: event.payload.activity.kind,
          summary: event.payload.activity.summary,
          payload: event.payload.activity.payload,
          ...(event.payload.activity.sequence !== undefined
            ? { sequence: event.payload.activity.sequence }
            : {}),
          createdAt: event.payload.activity.createdAt,
        });
        return;

      case "thread.reverted": {
        const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }
        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionActivitiesAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }
        yield* projectionThreadActivityRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities, apply };
}
