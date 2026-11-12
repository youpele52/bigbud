import { Schema } from "effect";
import { CommandId, IsoDateTime, NonNegativeInt, ThreadId, TurnId } from "../core/baseSchemas";

/** Only accepted native terminal events may supply this outcome; messages and checkpoints cannot. */
export const TurnTerminalOutcome = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type TurnTerminalOutcome = typeof TurnTerminalOutcome.Type;

export const ThreadTurnSettledPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  outcome: TurnTerminalOutcome,
  sessionEpoch: NonNegativeInt,
  completedAt: IsoDateTime,
});

export const ThreadTurnSettleCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.settle"),
  commandId: CommandId,
  ...ThreadTurnSettledPayload.fields,
  createdAt: IsoDateTime,
});
