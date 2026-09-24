import {
  CONVERSATION_SEARCH_DEFAULT_LIMIT,
  CONVERSATION_SEARCH_MAX_LIMIT,
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  type SearchConversationMessagesResult,
} from "@bigbud/contracts/orchestration/orchestration.search.ts";
import { IsoDateTime, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";
import { Effect, Schema } from "effect";
import { clamp } from "effect/Number";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import type { ProjectionCatalogQueryShape } from "../Services/ProjectionCatalogQuery.ts";
import { orchestrationSequenceFrontierSql } from "../../persistence/OrchestrationSequenceFrontier.ts";

const SearchRequest = Schema.Struct({
  match: Schema.String,
  query: Schema.String,
  cursor: Schema.NullOr(Schema.Number),
  limit: Schema.Number,
});

const SearchRow = Schema.Struct({
  rowId: Schema.Number,
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  projectName: Schema.String,
  snippet: Schema.String,
  createdAt: IsoDateTime,
});

const IndexState = Schema.Struct({
  objectCount: Schema.Number,
  projectionSequence: Schema.NullOr(Schema.Number),
  frontier: Schema.Number,
});

export function makeSearchConversationMessages(
  sql: SqlClient.SqlClient,
): ProjectionCatalogQueryShape["searchConversationMessages"] {
  const readState = SqlSchema.findOne({
    Request: Schema.Void,
    Result: IndexState,
    execute: () => sql`
      SELECT
        (SELECT COUNT(*) FROM sqlite_master WHERE name IN (
          'projection_message_search',
          'projection_message_search_insert',
          'projection_message_search_update',
          'projection_message_search_delete'
        )) AS "objectCount",
        (SELECT last_applied_sequence FROM projection_state
          WHERE projector = 'projection.thread-messages') AS "projectionSequence",
        ${orchestrationSequenceFrontierSql(sql)} AS frontier
    `,
  });
  const readHits = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ match, query, cursor, limit }) => sql`
      SELECT
        m.rowid AS "rowId",
        m.message_id AS "messageId",
        m.thread_id AS "threadId",
        t.project_id AS "projectId",
        t.title AS "threadTitle",
        COALESCE(p.title, 'Chats') AS "projectName",
        substr(
          m.text,
          max(1, instr(highlight(projection_message_search, 0, char(1), char(2)), char(1)) - 35),
          length(${query}) + 70
        ) AS snippet,
        m.created_at AS "createdAt"
      FROM projection_message_search search
      JOIN projection_thread_messages m ON m.rowid = search.rowid
      JOIN projection_threads t ON t.thread_id = m.thread_id
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE projection_message_search MATCH ${match}
        AND m.is_streaming = 0
        AND (${cursor} IS NULL OR m.rowid < ${cursor})
        AND t.purpose = 'standard'
        AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
        AND p.deleted_at IS NULL AND p.deleting_at IS NULL
      ORDER BY m.rowid DESC
      LIMIT ${limit}
    `,
  });

  return (input) => {
    const query = input.query.trim();
    const queryLength = countUnicodeCodePoints(query);
    const limit = clamp(input.limit ?? CONVERSATION_SEARCH_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: CONVERSATION_SEARCH_MAX_LIMIT,
    });
    const unavailable: SearchConversationMessagesResult = {
      status: "unavailable",
      projectionSequence: 0,
      hits: [],
    };
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const state = yield* readState(undefined);
          if (state.objectCount !== 4 || state.projectionSequence === null) {
            return unavailable;
          }
          const status =
            state.projectionSequence < state.frontier ? ("stale" as const) : ("ready" as const);
          if (
            queryLength < CONVERSATION_SEARCH_MIN_QUERY_LENGTH ||
            queryLength > CONVERSATION_SEARCH_MAX_QUERY_LENGTH
          ) {
            return { status, projectionSequence: state.projectionSequence, hits: [] };
          }
          const rows = yield* readHits({
            match: `"${query.replaceAll('"', '""')}"`,
            query,
            cursor: input.cursor ?? null,
            limit: limit + 1,
          });
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          return {
            status,
            projectionSequence: state.projectionSequence,
            hits: page.map((row) => ({
              messageId: row.messageId,
              threadId: row.threadId,
              projectId: row.projectId,
              threadTitle: row.threadTitle,
              projectName: row.projectName,
              snippet: row.snippet,
              createdAt: row.createdAt,
            })),
            ...(rows.length > limit && last ? { nextCursor: last.rowId } : {}),
          } satisfies SearchConversationMessagesResult;
        }),
      )
      .pipe(Effect.catch(() => Effect.succeed(unavailable)));
  };
}
