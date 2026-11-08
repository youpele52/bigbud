import {
  MESSAGE_TEXT_CHUNK_MAX_LENGTH,
  PROJECT_WORKTREE_PATHS_MAX,
  TURN_ACTIVITIES_DEFAULT_LIMIT,
  TURN_ACTIVITIES_MAX_LIMIT,
  type GetMessageTextChunkInput,
  type GetMessageTextChunkResult,
  type GetProjectWorktreePathsInput,
  type GetProjectWorktreePathsResult,
  type GetTurnActivitiesInput,
  type GetTurnActivitiesResult,
} from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";
import { NonNegativeInt } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option, Schema } from "effect";
import { clamp } from "effect/Number";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ThreadDetailActivityDbRow } from "./ProjectionCatalogQuery.schemas.ts";
import { boundedActivityPayloadColumnsSql } from "./ProjectionCatalogQuery.boundedText.ts";
import { normalizeDetailActivity } from "./ProjectionCatalogQuery.detail.activities.ts";

export interface ProjectionDetailPagingQueries {
  /** Newest `limit` activities of one turn, oldest first, through the thread/turn/sequence index. */
  readonly getTurnActivities: (
    input: GetTurnActivitiesInput,
  ) => Effect.Effect<GetTurnActivitiesResult, ProjectionRepositoryError>;
  /** One bounded chunk of a stored message; `None` when the message or its thread is gone. */
  readonly getMessageTextChunk: (
    input: GetMessageTextChunkInput,
  ) => Effect.Effect<Option.Option<GetMessageTextChunkResult>, ProjectionRepositoryError>;
  /** Distinct worktree paths of a project's non-deleted threads, capped. */
  readonly getProjectWorktreePaths: (
    input: GetProjectWorktreePathsInput,
  ) => Effect.Effect<GetProjectWorktreePathsResult, ProjectionRepositoryError>;
}

export function makeDetailPagingQueries(sql: SqlClient.SqlClient): ProjectionDetailPagingQueries {
  const readTurnActivities = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: Schema.String,
      turnId: Schema.String,
      limit: Schema.Number,
    }),
    Result: ThreadDetailActivityDbRow,
    execute: ({ threadId, turnId, limit }) => sql`
      SELECT activity_id AS "activityId", thread_id AS "threadId", turn_id AS "turnId",
        tone, kind, summary, ${boundedActivityPayloadColumnsSql(sql)}, sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND turn_id = ${turnId}
        AND EXISTS (
          SELECT 1 FROM projection_threads
          WHERE thread_id = ${threadId} AND deleted_at IS NULL
        )
      ORDER BY sequence DESC, activity_id ASC
      LIMIT ${limit}
    `,
  });

  const readTextChunk = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: Schema.String,
      messageId: Schema.String,
      offset: Schema.Number,
      limit: Schema.Number,
    }),
    Result: Schema.Struct({ text: Schema.String, textLength: NonNegativeInt }),
    execute: ({ threadId, messageId, offset, limit }) => sql`
      SELECT substr(m.text, ${offset + 1}, ${limit}) AS text, length(m.text) AS "textLength"
      FROM projection_thread_messages m
      JOIN projection_threads t ON t.thread_id = m.thread_id AND t.deleted_at IS NULL
      WHERE m.thread_id = ${threadId} AND m.message_id = ${messageId}
    `,
  });

  const readWorktreePaths = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String, limit: Schema.Number }),
    Result: Schema.Struct({ worktreePath: Schema.String }),
    execute: ({ projectId, limit }) => sql`
      SELECT DISTINCT worktree_path AS "worktreePath"
      FROM projection_threads
      WHERE project_id = ${projectId}
        AND deleted_at IS NULL
        AND worktree_path IS NOT NULL
      ORDER BY worktree_path ASC
      LIMIT ${limit}
    `,
  });

  return {
    getTurnActivities: (input) => {
      const limit = clamp(input.limit ?? TURN_ACTIVITIES_DEFAULT_LIMIT, {
        minimum: 1,
        maximum: TURN_ACTIVITIES_MAX_LIMIT,
      });
      return readTurnActivities({
        threadId: input.threadId,
        turnId: input.turnId,
        limit: limit + 1,
      }).pipe(
        Effect.map((rows) => ({
          threadId: input.threadId,
          turnId: input.turnId,
          activities: rows.slice(0, limit).map(normalizeDetailActivity).toReversed(),
          truncated: rows.length > limit,
        })),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getTurnActivities")),
      );
    },
    getMessageTextChunk: (input) => {
      const limit = clamp(input.limit ?? MESSAGE_TEXT_CHUNK_MAX_LENGTH, {
        minimum: 1,
        maximum: MESSAGE_TEXT_CHUNK_MAX_LENGTH,
      });
      return readTextChunk({ ...input, limit }).pipe(
        Effect.map(
          Option.map((row) => {
            const end = input.offset + row.text.length;
            return {
              threadId: input.threadId,
              messageId: input.messageId,
              offset: input.offset,
              text: row.text,
              textLength: row.textLength,
              nextOffset: end < row.textLength && row.text.length > 0 ? end : null,
            };
          }),
        ),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getMessageTextChunk")),
      );
    },
    getProjectWorktreePaths: (input) =>
      readWorktreePaths({ projectId: input.projectId, limit: PROJECT_WORKTREE_PATHS_MAX + 1 }).pipe(
        Effect.map((rows) => ({
          projectId: input.projectId,
          worktreePaths: rows.slice(0, PROJECT_WORKTREE_PATHS_MAX).map((row) => row.worktreePath),
          truncated: rows.length > PROJECT_WORKTREE_PATHS_MAX,
        })),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getProjectWorktreePaths")),
      ),
  };
}
