import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString, TurnId } from "../core/baseSchemas";

/**
 * One agent turn currently counted as using computer use (either surface).
 * `turnRunning` is the session's running-turn state, never the turn projection's `completedAt`.
 */
export const ComputerUseActivityTurn = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  actionInFlight: Schema.Boolean,
  turnRunning: Schema.Boolean,
  /** The turn used the desktop surface, so a Stop must reset the Cua driver. */
  usedDesktop: Schema.Boolean,
});
export type ComputerUseActivityTurn = typeof ComputerUseActivityTurn.Type;

export const ComputerUseActivitySnapshot = Schema.Struct({
  active: Schema.Boolean,
  turns: Schema.Array(ComputerUseActivityTurn),
});
export type ComputerUseActivitySnapshot = typeof ComputerUseActivitySnapshot.Type;

/**
 * `not-needed`: no active turn used the desktop surface; `unavailable`: desktop activity was
 * recorded but no Cua driver runs here (no daemon socket and no live proxy).
 */
export const ComputerUseStopDriverReset = Schema.Literals([
  "reset",
  "failed",
  "not-needed",
  "unavailable",
]);
export type ComputerUseStopDriverReset = typeof ComputerUseStopDriverReset.Type;

export const ComputerUseStopResult = Schema.Struct({
  /** Whether any turn was using computer use when this Stop ran. */
  active: Schema.Boolean,
  interruptedThreadIds: Schema.Array(ThreadId),
  failedThreadIds: Schema.Array(ThreadId),
  driverReset: ComputerUseStopDriverReset,
  driverResetError: Schema.NullOr(Schema.String),
});
export type ComputerUseStopResult = typeof ComputerUseStopResult.Type;

export class ComputerUseStopError extends Schema.TaggedErrorClass<ComputerUseStopError>()(
  "ComputerUseStopError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
