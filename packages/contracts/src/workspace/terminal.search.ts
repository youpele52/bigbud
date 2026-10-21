import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId } from "../core/baseSchemas";
import {
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
} from "../orchestration/orchestration.search";

/** Same bounds as saved-message search, so one palette query drives both. */
export const TERMINAL_SEARCH_MIN_QUERY_LENGTH = CONVERSATION_SEARCH_MIN_QUERY_LENGTH;
export const TERMINAL_SEARCH_MAX_QUERY_LENGTH = CONVERSATION_SEARCH_MAX_QUERY_LENGTH;
export const TERMINAL_SEARCH_DEFAULT_LIMIT = 30;
export const TERMINAL_SEARCH_MAX_LIMIT = 100;

/**
 * Case-insensitive substring search over the output terminals retain on the server (the same
 * bounded history used to restore a terminal view), newest lines first.
 */
export const TerminalSearchInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(PositiveInt),
});
export type TerminalSearchInput = typeof TerminalSearchInput.Type;

export const TerminalSearchHit = Schema.Struct({
  threadId: ThreadId,
  terminalId: Schema.String,
  /** The matching output line as displayed text (escape sequences removed), possibly clipped. */
  lineText: Schema.String,
  /** UTF-16 offset of the match within `lineText`. */
  matchStart: NonNegativeInt,
  /** 0 for the newest retained line. */
  linesFromEnd: NonNegativeInt,
  running: Schema.Boolean,
});
export type TerminalSearchHit = typeof TerminalSearchHit.Type;

export const TerminalSearchResult = Schema.Struct({
  hits: Schema.Array(TerminalSearchHit),
  /** More lines matched than `limit` allowed. */
  truncated: Schema.Boolean,
});
export type TerminalSearchResult = typeof TerminalSearchResult.Type;
