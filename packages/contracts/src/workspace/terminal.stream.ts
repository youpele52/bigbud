import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { TerminalEvent, TerminalSnapshotInput } from "./terminal";

/**
 * Terminal-scoped output delivery with an application-level parse-credit window.
 *
 * The server sends at most `TERMINAL_OUTPUT_CREDIT_WINDOW_CHARS` UTF-16 units of `output` data
 * that the client has not acknowledged as parsed (or discarded). Other events are never credited.
 */
export const TERMINAL_OUTPUT_CREDIT_WINDOW_CHARS = 256 * 1024;

export const TerminalSessionStreamInput = Schema.Struct({
  ...TerminalSnapshotInput.fields,
});
export type TerminalSessionStreamInput = Schema.Codec.Encoded<typeof TerminalSessionStreamInput>;

/** First item of every subscription; a later subscription (reconnect) gets a new identity. */
export const TerminalSessionSubscribed = Schema.Struct({
  type: Schema.Literal("subscribed"),
  subscriptionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});

export const TerminalSessionStreamItem = Schema.Union([TerminalSessionSubscribed, TerminalEvent]);
export type TerminalSessionStreamItem = typeof TerminalSessionStreamItem.Type;

export const TerminalOutputAckInput = Schema.Struct({
  subscriptionId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** Cumulative `output` units this subscription delivered that the view parsed or discarded. */
  processedChars: NonNegativeInt,
});
export type TerminalOutputAckInput = typeof TerminalOutputAckInput.Type;

/** Authoritative manager membership at subscription registration, before replay/live events. */
export const TerminalSessionInventory = Schema.Struct({
  type: Schema.Literal("inventory"),
  createdAt: Schema.String,
  sessions: Schema.Array(Schema.Struct({ threadId: Schema.String, terminalId: Schema.String })),
});
export type TerminalSessionInventory = typeof TerminalSessionInventory.Type;

/** Inventory is a subscription control item, never a per-terminal lifecycle event. */
export const TerminalEventsStreamItem = Schema.Union([TerminalSessionInventory, TerminalEvent]);
export type TerminalEventsStreamItem = typeof TerminalEventsStreamItem.Type;

/** `legacyDetection` omits output except for sessions whose agent detection runs in the client. */
export const TerminalEventsSubscriptionInput = Schema.Struct({
  outputScope: Schema.optional(Schema.Literals(["all", "legacyDetection"])),
  /** Opt in so older per-terminal consumers keep receiving only TerminalEvent. */
  includeInventory: Schema.optional(Schema.Boolean),
});
export type TerminalEventsSubscriptionInput = Schema.Codec.Encoded<
  typeof TerminalEventsSubscriptionInput
>;
