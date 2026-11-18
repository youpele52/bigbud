import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect } from "effect";
import { ThreadRevertedPayload } from "./Schemas.ts";
import {
  checkpointStatusToLatestTurnState,
  decodeForEvent,
  updateThread,
} from "./projectorHelpers.ts";
import {
  retainThreadActivitiesAfterRevert,
  retainThreadMessagesAfterRevert,
  retainThreadProposedPlansAfterRevert,
} from "./projectorThreadState.ts";

export function projectThreadReverted(
  model: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.reverted" }>,
) {
  return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
    // Effect.map transforms one decoded payload, not an array iteration.
    // oxlint-disable-next-line no-map-spread
    Effect.map((payload) => {
      const thread = model.threads.find((entry) => entry.id === payload.threadId);
      if (!thread) return model;
      const checkpoints = thread.checkpoints
        .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
        .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
        .slice(-500);
      const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
      const messages = retainThreadMessagesAfterRevert(
        thread.messages,
        retainedTurnIds,
        payload.turnCount,
      ).slice(-2_000);
      const proposedPlans = retainThreadProposedPlansAfterRevert(
        thread.proposedPlans,
        retainedTurnIds,
      ).slice(-200);
      const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
      const latestCheckpoint = checkpoints.at(-1) ?? null;
      const latestTurn =
        latestCheckpoint === null
          ? null
          : thread.latestTurn?.turnId === latestCheckpoint.turnId
            ? thread.latestTurn
            : {
                turnId: latestCheckpoint.turnId,
                state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                requestedAt: latestCheckpoint.completedAt,
                startedAt: latestCheckpoint.completedAt,
                completedAt: latestCheckpoint.completedAt,
                assistantMessageId: latestCheckpoint.assistantMessageId,
              };
      return {
        ...model,
        threads: updateThread(model.threads, payload.threadId, {
          checkpoints,
          messages,
          proposedPlans,
          activities,
          latestTurn,
          updatedAt: event.occurredAt,
        }),
      };
    }),
  );
}
