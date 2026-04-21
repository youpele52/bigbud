/**
 * ThreadTurns projector — handles turn lifecycle and checkpoint events.
 *
 * @module ProjectionPipeline.projector.threadTurns
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import {
  ORCHESTRATION_PROJECTOR_NAMES,
  type AttachmentSideEffects,
} from "./ProjectionPipeline.helpers.ts";
import { type ProjectorDefinition, type ProjectorDeps } from "./ProjectionPipeline.projectors.ts";

export function makeThreadTurnsProjector(
  deps: Pick<ProjectorDeps, "projectionTurnRepository">,
): ProjectorDefinition {
  const { projectionTurnRepository } = deps;

  const apply = Effect.fn("applyThreadTurnsProjection")(function* (
    event: OrchestrationEvent,
    _attachmentSideEffects: AttachmentSideEffects,
  ) {
    switch (event.type) {
      case "thread.turn-start-requested": {
        yield* projectionTurnRepository.replacePendingTurnStart({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
          sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
          requestedAt: event.payload.createdAt,
        });
        return;
      }

      case "thread.session-set": {
        const turnId = event.payload.session.activeTurnId;
        if (turnId === null || event.payload.session.status !== "running") {
          return;
        }

        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId,
        });
        const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
          threadId: event.payload.threadId,
        });
        if (Option.isSome(existingTurn)) {
          const nextState =
            existingTurn.value.state === "completed" || existingTurn.value.state === "error"
              ? existingTurn.value.state
              : "running";
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            state: nextState,
            pendingMessageId:
              existingTurn.value.pendingMessageId ??
              (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
            sourceProposedPlanThreadId:
              existingTurn.value.sourceProposedPlanThreadId ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null),
            sourceProposedPlanId:
              existingTurn.value.sourceProposedPlanId ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null),
            startedAt:
              existingTurn.value.startedAt ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt),
            requestedAt:
              existingTurn.value.requestedAt ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt),
          });
        } else {
          yield* projectionTurnRepository.upsertByTurnId({
            turnId,
            threadId: event.payload.threadId,
            pendingMessageId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.messageId
              : null,
            sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.sourceProposedPlanThreadId
              : null,
            sourceProposedPlanId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.sourceProposedPlanId
              : null,
            assistantMessageId: null,
            state: "running",
            requestedAt: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.requestedAt
              : event.occurredAt,
            startedAt: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.requestedAt
              : event.occurredAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
        }

        yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
          threadId: event.payload.threadId,
        });
        return;
      }

      case "thread.message-sent": {
        if (event.payload.turnId === null || event.payload.role !== "assistant") {
          return;
        }
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            assistantMessageId: event.payload.messageId,
            state: event.payload.streaming
              ? existingTurn.value.state
              : existingTurn.value.state === "interrupted"
                ? "interrupted"
                : existingTurn.value.state === "error"
                  ? "error"
                  : "completed",
            completedAt: event.payload.streaming
              ? existingTurn.value.completedAt
              : (existingTurn.value.completedAt ?? event.payload.updatedAt),
            startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
          });
          return;
        }
        yield* projectionTurnRepository.upsertByTurnId({
          turnId: event.payload.turnId,
          threadId: event.payload.threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: event.payload.messageId,
          state: event.payload.streaming ? "running" : "completed",
          requestedAt: event.payload.createdAt,
          startedAt: event.payload.createdAt,
          completedAt: event.payload.streaming ? null : event.payload.updatedAt,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        return;
      }

      case "thread.turn-interrupt-requested": {
        if (event.payload.turnId === undefined) {
          return;
        }
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            state: "interrupted",
            completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
            startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
          });
          return;
        }
        yield* projectionTurnRepository.upsertByTurnId({
          turnId: event.payload.turnId,
          threadId: event.payload.threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "interrupted",
          requestedAt: event.payload.createdAt,
          startedAt: event.payload.createdAt,
          completedAt: event.payload.createdAt,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        return;
      }

      case "thread.turn-diff-completed": {
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
        const nextState = event.payload.status === "error" ? "error" : "completed";
        yield* projectionTurnRepository.clearCheckpointTurnConflict({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
        });

        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
            startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
            completedAt: event.payload.completedAt,
          });
          return;
        }
        yield* projectionTurnRepository.upsertByTurnId({
          turnId: event.payload.turnId,
          threadId: event.payload.threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: event.payload.assistantMessageId,
          state: nextState,
          requestedAt: event.payload.completedAt,
          startedAt: event.payload.completedAt,
          completedAt: event.payload.completedAt,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          checkpointStatus: event.payload.status,
          checkpointFiles: event.payload.files,
        });
        return;
      }

      case "thread.reverted": {
        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptTurns = existingTurns.filter(
          (turn) =>
            turn.turnId !== null &&
            turn.checkpointTurnCount !== null &&
            turn.checkpointTurnCount <= event.payload.turnCount,
        );
        yield* projectionTurnRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(
          keptTurns,
          (turn) =>
            turn.turnId === null
              ? Effect.void
              : projectionTurnRepository.upsertByTurnId({
                  ...turn,
                  turnId: turn.turnId,
                }),
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
        return;
      }

      default:
        return;
    }
  });

  return { name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns, apply };
}
