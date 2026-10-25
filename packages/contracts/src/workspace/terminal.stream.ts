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

/** `legacyDetection` omits output except for sessions whose agent detection runs in the client. */
export const TerminalEventsSubscriptionInput = Schema.Struct({
  outputScope: Schema.optional(Schema.Literals(["all", "legacyDetection"])),
});
export type TerminalEventsSubscriptionInput = Schema.Codec.Encoded<
  typeof TerminalEventsSubscriptionInput
>;
