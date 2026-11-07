import { Schema } from "effect";

import {
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "../core/baseSchemas";
import { OrchestrationThreadActivity } from "./orchestration.thread";

/** Work log of one older turn, loaded when the user expands it. */
export const TURN_ACTIVITIES_DEFAULT_LIMIT = 100;
export const TURN_ACTIVITIES_MAX_LIMIT = 200;

export const GetTurnActivitiesInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  limit: Schema.optional(PositiveInt),
});
export type GetTurnActivitiesInput = typeof GetTurnActivitiesInput.Type;

export const GetTurnActivitiesResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  /** Oldest first, newest `limit` activities of the turn. */
  activities: Schema.Array(OrchestrationThreadActivity),
  truncated: Schema.Boolean,
});
export type GetTurnActivitiesResult = typeof GetTurnActivitiesResult.Type;

/** Largest chunk of message text one `getMessageTextChunk` call returns, in characters. */
export const MESSAGE_TEXT_CHUNK_MAX_LENGTH = 256 * 1024;

export const GetMessageTextChunkInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  offset: NonNegativeInt,
  limit: Schema.optional(PositiveInt),
});
export type GetMessageTextChunkInput = typeof GetMessageTextChunkInput.Type;

export const GetMessageTextChunkResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  offset: NonNegativeInt,
  text: Schema.String,
  textLength: NonNegativeInt,
  /** Offset of the next chunk, or null when this chunk reaches the end of the text. */
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type GetMessageTextChunkResult = typeof GetMessageTextChunkResult.Type;

/** Most distinct worktree paths one project read returns. */
export const PROJECT_WORKTREE_PATHS_MAX = 500;

export const GetProjectWorktreePathsInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectWorktreePathsInput = typeof GetProjectWorktreePathsInput.Type;

export const GetProjectWorktreePathsResult = Schema.Struct({
  projectId: ProjectId,
  worktreePaths: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
export type GetProjectWorktreePathsResult = typeof GetProjectWorktreePathsResult.Type;

export class OrchestrationGetTurnActivitiesError extends Schema.TaggedErrorClass<OrchestrationGetTurnActivitiesError>()(
  "OrchestrationGetTurnActivitiesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetMessageTextChunkError extends Schema.TaggedErrorClass<OrchestrationGetMessageTextChunkError>()(
  "OrchestrationGetMessageTextChunkError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationGetProjectWorktreePathsError extends Schema.TaggedErrorClass<OrchestrationGetProjectWorktreePathsError>()(
  "OrchestrationGetProjectWorktreePathsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
