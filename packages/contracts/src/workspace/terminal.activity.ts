import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId } from "../core/baseSchemas";

/** Command text kept for a finished item: a prefix of the submitted command line, never output. */
export const TERMINAL_FINISHED_COMMAND_MAX_CHARS = 120;
/** Commands shorter than this never raise attention (decision 2). */
export const TERMINAL_FINISHED_MIN_DURATION_MS = 60_000;
/** Recency writes per thread are coalesced to at most one per window (decision 8). */
export const TERMINAL_ACTIVITY_COALESCE_MS = 60_000;
/** SIGINT exit status: a Ctrl-C stop never raises attention (decision 7). */
export const TERMINAL_STOPPED_EXIT_CODE = 130;
/** A client's terminal view stops counting this long after its last report. */
export const TERMINAL_VIEW_LEASE_MS = 120_000;
/** Clients re-report what they view this often, well inside the view lease. */
export const TERMINAL_VIEW_REFRESH_MS = 45_000;
/** Exact TUI completion marker written by terminal agent hooks. */
export const TERMINAL_AGENT_DONE_MARKER = "\u001b]777;bigbud;done\u0007";

export const TerminalFinishedSource = Schema.Literals([
  "shell-integration",
  "process-poll",
  "agent-hook",
]);
export type TerminalFinishedSource = typeof TerminalFinishedSource.Type;

/** One pane's finished work that needs the user. No output, only the command prefix. */
export const TerminalFinishedItem = Schema.Struct({
  terminalId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  finishedAt: IsoDateTime,
  command: Schema.optional(
    Schema.String.check(Schema.isMaxLength(TERMINAL_FINISHED_COMMAND_MAX_CHARS)),
  ),
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
  source: TerminalFinishedSource,
});
export type TerminalFinishedItem = typeof TerminalFinishedItem.Type;

/**
 * Opt-in item of the global terminal events stream (`includeWork`). `latestActivityAt` is the
 * persisted recency; `finished` is a raised item, or `null` when the pane's item was cleared.
 */
export const TerminalWorkActivity = Schema.Struct({
  type: Schema.Literal("workActivity"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: IsoDateTime,
  latestActivityAt: Schema.optional(IsoDateTime),
  finished: Schema.optional(Schema.NullOr(TerminalFinishedItem)),
});
export type TerminalWorkActivity = typeof TerminalWorkActivity.Type;

/** What one client connection is looking at: the open thread and its visible panes. */
export const TerminalViewInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  terminalIds: Schema.Array(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  ).check(Schema.isMaxLength(16)),
});
export type TerminalViewInput = Schema.Codec.Encoded<typeof TerminalViewInput>;
