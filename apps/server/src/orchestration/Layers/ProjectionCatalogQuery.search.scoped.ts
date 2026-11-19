import { IsoDateTime, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/** Joins and visibility rules shared by every saved-message search query (alias `m`). */
export function searchVisibleMessageSql(sql: SqlClient.SqlClient) {
  return sql.unsafe(`JOIN projection_threads t ON t.thread_id = m.thread_id
      JOIN projection_projects p ON p.project_id = t.project_id
      WHERE m.is_streaming = 0
        AND t.purpose = 'standard'
        AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
        AND p.deleted_at IS NULL AND p.deleting_at IS NULL`);
}

export const SearchHitRow = Schema.Struct({
  rowId: Schema.Number,
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  projectName: Schema.String,
  snippet: Schema.String,
  createdAt: IsoDateTime,
  rank: Schema.Number,
});
export type SearchHitRow = typeof SearchHitRow.Type;

/**
 * Current-thread matches through the thread's own index and a substring scan, so 1–2 code point
 * queries work. Case folding is ASCII-only (`lower`); longer non-ASCII queries are still found
 * case-insensitively by the global FTS page, which the client folds into the same tier.
 */
export function makeCurrentThreadSearch(sql: SqlClient.SqlClient) {
  return SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, query: Schema.String, limit: Schema.Number }),
    Result: SearchHitRow,
    execute: ({ threadId, query, limit }) => sql`
      SELECT
        m.rowid AS "rowId",
        m.message_id AS "messageId",
        m.thread_id AS "threadId",
        t.project_id AS "projectId",
        t.title AS "threadTitle",
        COALESCE(p.title, 'Chats') AS "projectName",
        substr(m.text, max(1, instr(lower(m.text), lower(${query})) - 35), length(${query}) + 70)
          AS snippet,
        m.created_at AS "createdAt",
        0 AS rank
      FROM projection_thread_messages m
      ${searchVisibleMessageSql(sql)}
        AND m.thread_id = ${threadId}
        AND instr(lower(m.text), lower(${query})) > 0
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ${limit}
    `,
  });
}

/** Current-project matches: FTS `MATCH` filtered to one project, newest first. */
export function makeCurrentProjectSearch(sql: SqlClient.SqlClient) {
  return SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      match: Schema.String,
      query: Schema.String,
      limit: Schema.Number,
    }),
    Result: SearchHitRow,
    execute: ({ projectId, match, query, limit }) => sql`
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
        AND t.project_id = ${projectId}
      ORDER BY search.rowid DESC
      LIMIT ${limit}
    `,
  });
}

/** Wire shape of a hit row (drops the keyset and rank columns). */
export function toSearchHit(row: SearchHitRow) {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    projectId: row.projectId,
    threadTitle: row.threadTitle,
    projectName: row.projectName,
    snippet: row.snippet,
    createdAt: row.createdAt,
  };
}
