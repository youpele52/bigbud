import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import { TerminalEvent, TerminalSnapshotInput } from "./terminal";
import { TerminalWorkActivity } from "./terminal.activity";
import { TerminalLifecycleNotice } from "./terminal.lifecycle";
import {
  TERMINAL_RECOVERY_ANSI_MAX_CHARS,
  TERMINAL_RECOVERY_TAIL_MAX_CHARS,
} from "./terminal.recovery";

/**
 * Terminal-scoped output delivery with an application-level parse-credit window.
 *
 * The server sends at most `TERMINAL_OUTPUT_CREDIT_WINDOW_CHARS` UTF-16 units of `output` data
 * that the client has not acknowledged as parsed (or discarded). Other events are never credited.
 */
export const TERMINAL_OUTPUT_CREDIT_WINDOW_CHARS = 256 * 1024;

export const TerminalSessionStreamInput = Schema.Struct({
  ...TerminalSnapshotInput.fields,
  /** Opt in to one `screen` item right after `subscribed`; older servers ignore it. */
  acceptScreen: Schema.optional(Schema.Boolean),
});
export type TerminalSessionStreamInput = Schema.Codec.Encoded<typeof TerminalSessionStreamInput>;

/** First item of every subscription; a later subscription (reconnect) gets a new identity. */
export const TerminalSessionSubscribed = Schema.Struct({
  type: Schema.Literal("subscribed"),
  subscriptionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});

export const TerminalSessionStreamItem = Schema.Union([TerminalSessionSubscribed, TerminalEvent]);
export type TerminalSessionStreamItem = typeof TerminalSessionStreamItem.Type;

export const TerminalScreenFidelity = Schema.Literals(["full", "trimmed", "partial"]);
export type TerminalScreenFidelity = typeof TerminalScreenFidelity.Type;

/**
 * The host's serialized screen at output sequence `throughSequence` (a decimal string, so the
 * 64-bit host sequence survives JSON). Live output at or below it is already in `ansi`.
 */
export const TerminalScreenItem = Schema.Struct({
  type: Schema.Literal("screen"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  runtimeGeneration: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(128)),
  throughSequence: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/)),
  cols: PositiveInt.check(Schema.isLessThanOrEqualTo(1000)),
  rows: PositiveInt.check(Schema.isLessThanOrEqualTo(500)),
  ansi: Schema.String.check(Schema.isMaxLength(TERMINAL_RECOVERY_ANSI_MAX_CHARS)),
  pendingEscapeTail: Schema.String.check(Schema.isMaxLength(TERMINAL_RECOVERY_TAIL_MAX_CHARS)),
  scrollbackRows: NonNegativeInt,
  alternateScreen: Schema.Boolean,
  fidelity: TerminalScreenFidelity,
  /** Rebuilt from the spool after a host loss rather than from a live screen model. */
  cold: Schema.Boolean,
});
export type TerminalScreenItem = typeof TerminalScreenItem.Type;

/**
 * Everything `subscribeTerminalSession` can carry. A `screen` item is sent only to subscribers
 * that passed `acceptScreen`, always first after `subscribed`; other consumers keep
 * `TerminalSessionStreamItem`.
 */
export const TerminalSessionStreamRpcItem = Schema.Union([
  TerminalSessionSubscribed,
  TerminalScreenItem,
  TerminalEvent,
]);
export type TerminalSessionStreamRpcItem = typeof TerminalSessionStreamRpcItem.Type;

export const TerminalOutputAckInput = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Cumulative `output` units this subscription delivered that the view parsed or discarded. */
  processedChars: NonNegativeInt,
});
export type TerminalOutputAckInput = typeof TerminalOutputAckInput.Type;

export const TerminalInventoryActivity = Schema.Literals(["busy", "quiet"]);
export type TerminalInventoryActivity = typeof TerminalInventoryActivity.Type;

/** Authoritative manager membership at subscription registration, before replay/live events. */
export const TerminalSessionInventory = Schema.Struct({
  type: Schema.Literal("inventory"),
  createdAt: Schema.String,
  sessions: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      terminalId: Schema.String,
      /** Sidebar activity (plan §8.5): a program in front, or output in the last 60 s. */
      activity: Schema.optional(TerminalInventoryActivity),
      restorable: Schema.optional(Schema.Boolean),
      /** Set while an idle warning is pending. */
      idleClosesAt: Schema.optional(IsoDateTime),
    }),
  ),
});
export type TerminalSessionInventory = typeof TerminalSessionInventory.Type;

/** Inventory and work activity are subscription items, never per-terminal lifecycle events. */
export const TerminalEventsStreamItem = Schema.Union([
  TerminalSessionInventory,
  TerminalWorkActivity,
  TerminalLifecycleNotice,
  TerminalEvent,
]);
export type TerminalEventsStreamItem = typeof TerminalEventsStreamItem.Type;

/** `legacyDetection` omits output except for sessions whose agent detection runs in the client. */
export const TerminalEventsSubscriptionInput = Schema.Struct({
  outputScope: Schema.optional(Schema.Literals(["all", "legacyDetection"])),
  /** Opt in so older per-terminal consumers keep receiving only TerminalEvent. */
  includeInventory: Schema.optional(Schema.Boolean),
  /** Opt in to `workActivity` items (terminal recency and finished work). */
  includeWork: Schema.optional(Schema.Boolean),
  /** Opt in to `lifecycleNotice` items (idle warnings, closes, limit refusals). */
  includeLifecycle: Schema.optional(Schema.Boolean),
});
export type TerminalEventsSubscriptionInput = Schema.Codec.Encoded<
  typeof TerminalEventsSubscriptionInput
>;
