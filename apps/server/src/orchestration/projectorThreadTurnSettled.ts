import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";

export function projectThreadTurnSettled(
  model: OrchestrationReadModel,
  event: Extract<OrchestrationEvent, { type: "thread.turn-settled" }>,
): OrchestrationReadModel {
  return {
    ...model,
    threads: model.threads.map((thread) => {
      const previous = thread.latestTurn;
      if (
        thread.id !== event.payload.threadId ||
        thread.deletedAt != null ||
        (previous && previous.turnId !== event.payload.turnId) ||
        previous?.terminalOutcome != null ||
        event.payload.sessionEpoch !== (thread.session?.sessionEpoch ?? 0)
      )
        return thread;
      return {
        ...thread,
        latestTurn: {
          ...previous,
          turnId: event.payload.turnId,
          terminalOutcome: event.payload.outcome,
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
        },
        updatedAt: event.occurredAt,
      };
    }),
  };
}
