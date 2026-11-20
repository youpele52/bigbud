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
/** Current-thread matching is a substring scan of one thread, so it accepts 1–2 code points. */
export const CONVERSATION_SEARCH_SCOPED_MIN_QUERY_LENGTH = 1;
/** Rows returned per scoped tier (current thread, current project) on the first page. */
export const CONVERSATION_SEARCH_SCOPED_LIMIT = 20;

export const SearchConversationMessagesInput = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(PositiveInt),
  cursor: Schema.optional(NonNegativeInt),
  /** Ranks this thread first and returns its matches (any length) on the first page. */
  currentThreadId: Schema.optional(ThreadId),
  /** Ranks this project second and returns its matches on the first page. */
  currentProjectId: Schema.optional(ProjectId),
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
  /** Global page: newest-first keyset, reordered within the page by tier, relevance, recency. */
  hits: Schema.Array(ConversationMessageSearchHit),
  nextCursor: Schema.optional(NonNegativeInt),
  /** First page only, when `currentThreadId` was sent. */
  currentThreadHits: Schema.optional(Schema.Array(ConversationMessageSearchHit)),
  /** First page only, when `currentProjectId` was sent and the query is long enough. */
  currentProjectHits: Schema.optional(Schema.Array(ConversationMessageSearchHit)),
});
export type SearchConversationMessagesResult = typeof SearchConversationMessagesResult.Type;

export class OrchestrationSearchConversationMessagesError extends Schema.TaggedErrorClass<OrchestrationSearchConversationMessagesError>()(
  "OrchestrationSearchConversationMessagesError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect) },
) {}
