import {
  CONVERSATION_SEARCH_DEFAULT_LIMIT,
  CONVERSATION_SEARCH_MAX_LIMIT,
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_SCOPED_LIMIT,
  CONVERSATION_SEARCH_SCOPED_MIN_QUERY_LENGTH,
  type SearchConversationMessagesResult,
} from "@bigbud/contracts/orchestration/orchestration.search.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";
import { Effect, Schema } from "effect";
import { clamp } from "effect/Number";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import type { ProjectionCatalogQueryShape } from "../Services/ProjectionCatalogQuery.ts";
import { orchestrationSequenceFrontierSql } from "../../persistence/OrchestrationSequenceFrontier.ts";
import { rankSearchPage, searchPageCursor } from "./ProjectionCatalogQuery.search.rank.ts";
import {
  makeCurrentProjectSearch,
  makeCurrentThreadSearch,
  SearchHitRow,
  searchVisibleMessageSql,
  toSearchHit,
} from "./ProjectionCatalogQuery.search.scoped.ts";

const SearchRequest = Schema.Struct({
  match: Schema.String,
  query: Schema.String,
  cursor: Schema.NullOr(Schema.Number),
  limit: Schema.Number,
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
    Result: SearchHitRow,
    // Ordering by the FTS table's own rowid scans backwards and stops at the limit; ordering by
    // the content table's rowid (the same value) forced a temporary B-tree over every match.
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
        m.created_at AS "createdAt",
        bm25(projection_message_search) AS rank
      FROM projection_message_search search
      JOIN projection_thread_messages m ON m.rowid = search.rowid
      ${searchVisibleMessageSql(sql)}
        AND projection_message_search MATCH ${match}
        AND (${cursor} IS NULL OR search.rowid < ${cursor})
      ORDER BY search.rowid DESC
      LIMIT ${limit}
    `,
  });
  const readCurrentThreadHits = makeCurrentThreadSearch(sql);
  const readCurrentProjectHits = makeCurrentProjectSearch(sql);

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
            queryLength < CONVERSATION_SEARCH_SCOPED_MIN_QUERY_LENGTH ||
            queryLength > CONVERSATION_SEARCH_MAX_QUERY_LENGTH
          ) {
            return { status, projectionSequence: state.projectionSequence, hits: [] };
          }
          const firstPage = input.cursor === undefined;
          const match = `"${query.replaceAll('"', '""')}"`;
          const currentThreadHits =
            firstPage && input.currentThreadId !== undefined
              ? yield* readCurrentThreadHits({
                  threadId: input.currentThreadId,
                  query,
                  limit: CONVERSATION_SEARCH_SCOPED_LIMIT,
                })
              : undefined;
          if (queryLength < CONVERSATION_SEARCH_MIN_QUERY_LENGTH) {
            return {
              status,
              projectionSequence: state.projectionSequence,
              hits: [],
              ...(currentThreadHits
                ? { currentThreadHits: currentThreadHits.map(toSearchHit) }
                : {}),
            } satisfies SearchConversationMessagesResult;
          }
          const currentProjectHits =
            firstPage && input.currentProjectId !== undefined
              ? yield* readCurrentProjectHits({
                  projectId: input.currentProjectId,
                  match,
                  query,
                  limit: CONVERSATION_SEARCH_SCOPED_LIMIT,
                })
              : undefined;
          const rows = yield* readHits({
            match,
            query,
            cursor: input.cursor ?? null,
            limit: limit + 1,
          });
          const page = rows.slice(0, limit);
          const nextCursor = rows.length > limit ? searchPageCursor(page) : undefined;
          return {
            status,
            projectionSequence: state.projectionSequence,
            hits: rankSearchPage(page, input).map(toSearchHit),
            ...(nextCursor === undefined ? {} : { nextCursor }),
            ...(currentThreadHits ? { currentThreadHits: currentThreadHits.map(toSearchHit) } : {}),
            ...(currentProjectHits
              ? { currentProjectHits: currentProjectHits.map(toSearchHit) }
              : {}),
          } satisfies SearchConversationMessagesResult;
        }),
      )
      .pipe(Effect.catch(() => Effect.succeed(unavailable)));
  };
}
