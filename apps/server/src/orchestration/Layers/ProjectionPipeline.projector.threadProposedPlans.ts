/**
 * ThreadProposedPlans projector — handles proposed plan upserts and reverts.
 *
 * @module ProjectionPipeline.projector.threadProposedPlans
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
  retainProjectionProposedPlansAfterRevert,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadProposedPlansProjector(
  deps: Pick<ProjectorDeps, "projectionThreadProposedPlanRepository" | "projectionTurnRepository">,
): ProjectorDefinition {
  const { projectionThreadProposedPlanRepository, projectionTurnRepository } = deps;

  const apply = Effect.fn("applyThreadProposedPlansProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.proposed-plan-upserted":
        yield* projectionThreadProposedPlanRepository.upsert({
          planId: event.payload.proposedPlan.id,
          threadId: event.payload.threadId,
          turnId: event.payload.proposedPlan.turnId,
          planMarkdown: event.payload.proposedPlan.planMarkdown,
          implementedAt: event.payload.proposedPlan.implementedAt,
          implementationThreadId: event.payload.proposedPlan.implementationThreadId,
          createdAt: event.payload.proposedPlan.createdAt,
          updatedAt: event.payload.proposedPlan.updatedAt,
        });
        return;

      case "thread.reverted": {
        const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }

        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionProposedPlansAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }

        yield* projectionThreadProposedPlanRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans, apply };
}
