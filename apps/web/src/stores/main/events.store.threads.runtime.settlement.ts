import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { Thread } from "../../models/types";
import { buildLatestTurn } from "./helpers.latestTurn.store";

export function applyThreadTurnSettlement(
  thread: Thread,
  event: Extract<OrchestrationEvent, { type: "thread.turn-settled" }>,
): Thread {
  const previous = thread.latestTurn;
  if (
    (previous && previous.turnId !== event.payload.turnId) ||
    previous?.terminalOutcome != null ||
    event.payload.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)
  )
    return thread;
  return {
    ...thread,
    latestTurn: {
      ...buildLatestTurn({
        previous,
        turnId: event.payload.turnId,
        state:
          event.payload.outcome === "completed"
            ? "completed"
            : event.payload.outcome === "failed"
              ? "error"
              : "interrupted",
        requestedAt: previous?.requestedAt ?? event.occurredAt,
        startedAt: previous?.startedAt ?? event.occurredAt,
        completedAt: event.payload.completedAt,
        assistantMessageId: previous?.assistantMessageId ?? null,
      }),
      terminalOutcome: event.payload.outcome,
    },
  };
}
