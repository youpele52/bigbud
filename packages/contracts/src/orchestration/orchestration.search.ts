import { Schema } from "effect";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
} from "../core/baseSchemas";

export const CONVERSATION_SEARCH_MIN_QUERY_LENGTH = 3;
export const CONVERSATION_SEARCH_MAX_QUERY_LENGTH = 160;
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 10;
export const CONVERSATION_SEARCH_MAX_LIMIT = 30;

export const SearchConversationMessagesInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(PositiveInt),
  cursor: Schema.optional(NonNegativeInt),
});
export type SearchConversationMessagesInput = typeof SearchConversationMessagesInput.Type;

export const ConversationMessageSearchHit = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  projectName: Schema.String,
  snippet: Schema.String,
  createdAt: IsoDateTime,
});
export type ConversationMessageSearchHit = typeof ConversationMessageSearchHit.Type;

export const SearchConversationMessagesResult = Schema.Struct({
  status: Schema.Literals(["ready", "stale", "unavailable"]),
  projectionSequence: NonNegativeInt,
  hits: Schema.Array(ConversationMessageSearchHit),
  nextCursor: Schema.optional(NonNegativeInt),
});
export type SearchConversationMessagesResult = typeof SearchConversationMessagesResult.Type;

export class OrchestrationSearchConversationMessagesError extends Schema.TaggedErrorClass<OrchestrationSearchConversationMessagesError>()(
  "OrchestrationSearchConversationMessagesError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}
