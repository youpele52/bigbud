import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";

/** Default most managed live terminals one host keeps (plan §8.8); hosts clamp to 1..40. */
export const TERMINAL_LIVE_LIMIT_DEFAULT = 24;

const TerminalLimitIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/** One pane, named by the client: the terminal an open with `evict` may close first. */
export const TerminalEvictTarget = Schema.Struct({
  threadId: TerminalLimitIdentity,
  terminalId: TerminalLimitIdentity,
});
export type TerminalEvictTarget = typeof TerminalEvictTarget.Type;

/** The least recently used managed, not visible terminal; it may be busy. */
export const TerminalLimitCandidate = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  lastUsedAt: IsoDateTime,
  busy: Schema.Boolean,
});
export type TerminalLimitCandidate = typeof TerminalLimitCandidate.Type;

/**
 * The host refused a new managed terminal at its live limit. `candidate` is null when every
 * live terminal is visible, so none can be closed for the caller.
 */
export class TerminalLimitError extends Schema.TaggedErrorClass<TerminalLimitError>()(
  "TerminalLimitError",
  {
    limit: PositiveInt,
    liveCount: NonNegativeInt,
    candidate: Schema.NullOr(TerminalLimitCandidate),
  },
) {
  override get message() {
    return `Terminal limit reached: ${this.liveCount} of ${this.limit} terminals are running`;
  }
}

/** Where a session's screen comes from: the terminal host's screen model, or server history. */
export const TerminalScreenSource = Schema.Literals(["host", "history"]);
export type TerminalScreenSource = typeof TerminalScreenSource.Type;

/** Why a session ended; `exited` is the process's own exit. */
export const TerminalEndedReason = Schema.Literals([
  "user",
  "idle",
  "memory",
  "limit",
  "quit",
  "orphan",
  "host-lost",
  "exited",
]);
export type TerminalEndedReason = typeof TerminalEndedReason.Type;

/**
 * Closes the host decided on (idle, memory pressure, the live limit, no owner): the pane is gone
 * and an open never respawns it; only New terminal (a new id) starts a shell (plan §11.1).
 */
export const TERMINAL_HOST_CLOSED_REASONS: ReadonlyArray<TerminalEndedReason> = [
  "idle",
  "memory",
  "limit",
  "orphan",
];
