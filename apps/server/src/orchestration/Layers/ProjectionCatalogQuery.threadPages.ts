import type {
  GetProjectThreadSummariesInput,
  GetProjectThreadSummariesResult,
  ThreadSummary,
  ThreadSummaryCursor,
  ThreadSummarySortOrder,
} from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ThreadSummaryDbRow, normalizeThreadSummary } from "./ProjectionCatalogQuery.schemas.ts";
import {
  threadSummaryColumnsSql,
  threadSummaryJoinsSql,
} from "./ProjectionCatalogQuery.summaryColumns.ts";

/**
 * Sort key of each displayed order. The expressions match the migration 154 partial indexes
 * character for character, so SQLite can walk them instead of sorting.
 */
const SORT_KEY_SQL: Record<ThreadSummarySortOrder, string> = {
  updated_at: "COALESCE(t.latest_user_message_at, t.created_at)",
  created_at: "t.created_at",
};

/** The live-thread predicate shared by the migration 154 partial indexes. */
export const LIVE_STANDARD_THREAD_SQL = `
  t.purpose = 'standard'
  AND t.deleted_at IS NULL
  AND t.archived_at IS NULL
  AND t.deleting_at IS NULL
`;

export function threadSortKeySql(sql: SqlClient.SqlClient, sortOrder: ThreadSummarySortOrder) {
  return sql.unsafe(SORT_KEY_SQL[sortOrder]);
}

/** Display sort key of a summary row, as the client computes it. */
export function threadSummarySortKey(
  summary: Pick<ThreadSummary, "latestUserMessageAt" | "createdAt">,
  sortOrder: ThreadSummarySortOrder,
): string {
  return sortOrder === "created_at"
    ? summary.createdAt
    : (summary.latestUserMessageAt ?? summary.createdAt);
}

export function nextSortedThreadCursor(
  last: ThreadSummary,
  sortOrder: ThreadSummarySortOrder,
): ThreadSummaryCursor {
  return {
    updatedAt: last.updatedAt,
    threadId: last.id,
    sortKey: threadSummarySortKey(last, sortOrder),
    sortOrder,
  };
}

const SortedProjectPageRequest = Schema.Struct({
  projectId: Schema.String,
  sortOrder: Schema.Literals(["updated_at", "created_at"]),
  limit: Schema.Number,
  cursorSortKey: Schema.NullOr(Schema.String),
  cursorThreadId: Schema.NullOr(Schema.String),
});

const PriorityThreadRequest = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.String,
});

/** Keyset pages of one project's live threads in displayed order. */
export function makeSortedProjectThreadReaders(sql: SqlClient.SqlClient) {
  const readPage = SqlSchema.findAll({
    Request: SortedProjectPageRequest,
    Result: ThreadSummaryDbRow,
    execute: ({ projectId, sortOrder, limit, cursorSortKey, cursorThreadId }) => {
      const sortKey = threadSortKeySql(sql, sortOrder);
      return sql`
        SELECT ${threadSummaryColumnsSql(sql)}
        FROM projection_threads t
        ${threadSummaryJoinsSql(sql)}
        WHERE t.project_id = ${projectId}
          AND ${sql.unsafe(LIVE_STANDARD_THREAD_SQL)}
          AND (
            ${cursorSortKey} IS NULL
            OR ${sortKey} < ${cursorSortKey}
            OR (${sortKey} = ${cursorSortKey} AND t.thread_id < ${cursorThreadId})
          )
        ORDER BY ${sortKey} DESC, t.thread_id DESC
        LIMIT ${limit}
      `;
    },
  });

  const readPriorityThread = SqlSchema.findAll({
    Request: PriorityThreadRequest,
    Result: ThreadSummaryDbRow,
    execute: ({ projectId, threadId }) => sql`
      SELECT ${threadSummaryColumnsSql(sql)}
      FROM projection_threads t
      ${threadSummaryJoinsSql(sql)}
      WHERE t.thread_id = ${threadId}
        AND t.project_id = ${projectId}
        AND ${sql.unsafe(LIVE_STANDARD_THREAD_SQL)}
    `,
  });

  return { readPage, readPriorityThread };
}

/**
 * Display-ordered keyset page. The priority thread is fetched by key and prepended when it falls
 * outside the first page, so the page itself stays an index walk; clients drop the duplicate if it
 * shows up again on a later page.
 */
export function makeGetSortedProjectThreadSummaries(
  sql: SqlClient.SqlClient,
  readProjectionSequence: () => Effect.Effect<number, ProjectionRepositoryError>,
) {
  const readers = makeSortedProjectThreadReaders(sql);
  return (
    input: GetProjectThreadSummariesInput,
    sortOrder: ThreadSummarySortOrder,
    limit: number,
  ): Effect.Effect<GetProjectThreadSummariesResult, ProjectionRepositoryError> => {
    // A cursor from another order cannot continue this one; restart from the first page.
    const cursor =
      input.cursor?.sortOrder === sortOrder && input.cursor.sortKey !== undefined
        ? input.cursor
        : undefined;
    const priorityThreadId = cursor ? undefined : input.priorityThreadId;
    return sql
      .withTransaction(
        Effect.all({
          sequence: readProjectionSequence(),
          rows: readers.readPage({
            projectId: input.projectId,
            sortOrder,
            limit: limit + 1,
            cursorSortKey: cursor?.sortKey ?? null,
            cursorThreadId: cursor?.threadId ?? null,
          }),
          priority: priorityThreadId
            ? readers.readPriorityThread({ projectId: input.projectId, threadId: priorityThreadId })
            : Effect.succeed([]),
        }),
      )
      .pipe(
        Effect.map(({ rows, priority, sequence }) => {
          const pageThreads = rows.slice(0, limit).map(normalizeThreadSummary);
          const last = pageThreads.at(-1);
          const pageIds = new Set(pageThreads.map((thread) => thread.id));
          const priorityThreads = priority
            .map(normalizeThreadSummary)
            .filter((thread) => !pageIds.has(thread.id));
          return {
            projectionSequence: sequence,
            projectId: input.projectId,
            threads: [...priorityThreads, ...pageThreads],
            ...(rows.length > limit && last
              ? { nextCursor: nextSortedThreadCursor(last, sortOrder) }
              : {}),
          };
        }),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getProjectThreadSummaries")),
      );
  };
}
