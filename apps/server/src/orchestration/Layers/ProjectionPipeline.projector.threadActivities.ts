/**
 * ThreadActivities projector — handles activity appends and reverts.
 *
 * @module ProjectionPipeline.projector.threadActivities
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
  retainProjectionActivitiesAfterRevert,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";
import { usageContributionFromActivity } from "./ProjectionPipeline.projector.threadActivities.usage.ts";

export function makeThreadActivitiesProjector(
  deps: Pick<ProjectorDeps, "projectionThreadActivityRepository" | "projectionTurnRepository">,
): ProjectorDefinition {
  const { projectionThreadActivityRepository, projectionTurnRepository } = deps;

  const apply = Effect.fn("applyThreadActivitiesProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.deleted":
        yield* projectionThreadActivityRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* projectionThreadActivityRepository.deleteUsageByThreadId({
          threadId: event.payload.threadId,
        });
        return;

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
        {
          const contribution = usageContributionFromActivity({
            threadId: event.payload.threadId,
            activity: event.payload.activity,
          });
          if (contribution) {
            const turn = contribution.turnId
              ? yield* projectionTurnRepository.getByTurnId({
                  threadId: contribution.threadId,
                  turnId: contribution.turnId,
                })
              : Option.none();
            const attribution = Option.isSome(turn) ? turn.value.usageAttribution : null;
            yield* projectionThreadActivityRepository.upsertUsageContribution({
              ...contribution,
              model: contribution.accounting?.model ?? attribution?.model ?? "unknown",
              interactionMode: attribution?.interactionMode ?? "default",
              occurredAt:
                (contribution.accounting || contribution.codexObservation) && Option.isSome(turn)
                  ? turn.value.requestedAt
                  : contribution.occurredAt,
            });
          }
        }
        return;

      case "thread.reverted": {
        const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionActivitiesAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        const retired = existingTurns
          .filter(
            (turn) =>
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount,
          )
          .flatMap((turn) => (turn.turnId ? [turn.turnId] : []));
        if (projectionThreadActivityRepository.retireUsageTurns) {
          yield* projectionThreadActivityRepository.retireUsageTurns(
            event.payload.threadId,
            retired,
          );
        }
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
