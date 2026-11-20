import type { OrchestrationCommand, OrchestrationReadModel } from "@bigbud/contracts";
import { Effect } from "effect";
import { requireThread } from "./commandInvariants.ts";
import { withEventBase } from "./deciderHelpers.ts";

/** The ingestion fence is checked again at the serialized command boundary. */
export const decideThreadTurnSettle = Effect.fn("decideThreadTurnSettle")(function* ({
  command,
  readModel,
}: {
  command: Extract<OrchestrationCommand, { type: "thread.turn.settle" }>;
  readModel: OrchestrationReadModel;
}) {
  const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
  if (
    command.sessionEpoch !== (thread.session?.sessionEpoch ?? 0) ||
    (thread.session?.activeTurnId != null && thread.session.activeTurnId !== command.turnId) ||
    (thread.latestTurn != null && thread.latestTurn.turnId !== command.turnId) ||
    thread.latestTurn?.terminalOutcome != null
  )
    return [];
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: command.threadId,
      occurredAt: command.createdAt,
      commandId: command.commandId,
    }),
    type: "thread.turn-settled" as const,
    payload: {
      threadId: command.threadId,
      turnId: command.turnId,
      outcome: command.outcome,
      sessionEpoch: command.sessionEpoch,
      completedAt: command.completedAt,
    },
  };
});
