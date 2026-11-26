import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { TerminalEvictTarget, TerminalLimitCandidate } from "./terminal.limit";

const TerminalLifecycleIdentity = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/**
 * Why the server tells clients about a terminal's lifecycle (plan §11.3). Adding a kind later
 * needs a new subscription opt-in, because an older client rejects an unknown literal.
 */
export const TerminalLifecycleNoticeKind = Schema.Literals([
  "idleWarning",
  "idleWarningCleared",
  "idleClosed",
  "pressureClosed",
  "pressureNoCandidate",
  "limitClosed",
  "orphanClosed",
  "quitClosed",
  "modelInvalid",
  "spoolDegraded",
  "setupBlockedByLimit",
  /** Replayed summary of terminals closed while bigbud was not running; see `count`. */
  "offlineClosed",
  "hostLost",
  "legacyHostUnreachable",
  "backendRestartStopped",
]);
export type TerminalLifecycleNoticeKind = typeof TerminalLifecycleNoticeKind.Type;

/** A `terminal.events` item, sent only to subscribers that passed `includeLifecycle`. */
export const TerminalLifecycleNotice = Schema.Struct({
  type: Schema.Literal("lifecycleNotice"),
  /** Stable across replays, so a client shows each notice once. */
  noticeId: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128)),
  kind: TerminalLifecycleNoticeKind,
  threadId: Schema.optional(Schema.String),
  terminalId: Schema.optional(Schema.String),
  /** When an idle warning's terminal closes. */
  closesAt: Schema.optional(IsoDateTime),
  /** The terminal a limit retry would close (`setupBlockedByLimit`). */
  candidate: Schema.optional(TerminalLimitCandidate),
  /** The live limit that refused the request (`setupBlockedByLimit`). */
  limit: Schema.optional(PositiveInt),
  /** How many terminals a summary notice covers (`offlineClosed`). */
  count: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type TerminalLifecycleNotice = typeof TerminalLifecycleNotice.Type;

/** Restart the idle timer of one terminal ("Keep open"). */
export const TerminalKeepOpenInput = Schema.Struct({
  threadId: TerminalLifecycleIdentity,
  terminalId: TerminalLifecycleIdentity,
});
export type TerminalKeepOpenInput = typeof TerminalKeepOpenInput.Type;

/** Run a setup script the live limit refused, closing `evict` first. */
export const TerminalRetrySetupInput = Schema.Struct({
  threadId: TerminalLifecycleIdentity,
  evict: TerminalEvictTarget,
});
export type TerminalRetrySetupInput = typeof TerminalRetrySetupInput.Type;

export const TerminalRetrySetupResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("no-script") }),
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptId: Schema.String,
    scriptName: Schema.String,
    terminalId: Schema.String,
    cwd: Schema.String,
  }),
]);
export type TerminalRetrySetupResult = typeof TerminalRetrySetupResult.Type;

/**
 * "Close them" for terminal hosts from a previous bigbud version that can't be reconnected
 * (`legacyHostUnreachable`). Only hosts whose process identity is verified are closed.
 */
export const TerminalCloseDrainingHostsInput = Schema.Struct({});
export type TerminalCloseDrainingHostsInput = typeof TerminalCloseDrainingHostsInput.Type;

export const TerminalCloseDrainingHostsResult = Schema.Struct({
  closed: NonNegativeInt,
  /** Hosts left running because they could not be identified safely or did not stop. */
  remaining: NonNegativeInt,
});
export type TerminalCloseDrainingHostsResult = typeof TerminalCloseDrainingHostsResult.Type;
