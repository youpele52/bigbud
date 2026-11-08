import {
  ORGANIZATION_THREAD_SUMMARY_DEFAULT_LIMIT,
  ORGANIZATION_THREAD_SUMMARY_MAX_LIMIT,
} from "@bigbud/contracts/orchestration/orchestration.catalog.organization.ts";
import { Effect, Schema } from "effect";
import { clamp } from "effect/Number";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectionCatalogQueryShape } from "../Services/ProjectionCatalogQuery.ts";
import { ThreadSummaryDbRow, normalizeThreadSummary } from "./ProjectionCatalogQuery.schemas.ts";
import {
  threadSummaryColumnsSql,
  threadSummaryJoinsSql,
} from "./ProjectionCatalogQuery.summaryColumns.ts";
import { nextSortedThreadCursor, threadSortKeySql } from "./ProjectionCatalogQuery.threadPages.ts";

const OrganizationPageRequest = Schema.Struct({
  state: Schema.String,
  limit: Schema.Number,
  cursorSortKey: Schema.NullOr(Schema.String),
  cursorThreadId: Schema.NullOr(Schema.String),
});

const activeOrganizationThreadsSql = (sql: SqlClient.SqlClient, state: string) => sql`
  t.organization_state = ${state}
  AND t.deleted_at IS NULL
  AND t.archived_at IS NULL
  AND t.deleting_at IS NULL
  AND t.purpose = 'standard'
`;

/**
 * One keyset page of active threads in an Inyosira state across every project, in the displayed
 * order (latest user message, falling back to creation), served by the migration 154 partial index.
 */
export function makeGetOrganizationThreadSummaries(
  sql: SqlClient.SqlClient,
  readProjectionSequence: () => Effect.Effect<number, ProjectionRepositoryError>,
): ProjectionCatalogQueryShape["getOrganizationThreadSummaries"] {
  const readThreads = SqlSchema.findAll({
    Request: OrganizationPageRequest,
    Result: ThreadSummaryDbRow,
    execute: ({ state, limit, cursorSortKey, cursorThreadId }) => {
      const sortKey = threadSortKeySql(sql, "updated_at");
      return sql`
        SELECT ${threadSummaryColumnsSql(sql)}
        FROM projection_threads t
        ${threadSummaryJoinsSql(sql)}
        WHERE ${activeOrganizationThreadsSql(sql, state)}
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

  const readCount = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ totalCount: Schema.Number }),
    execute: (state) => sql`
      SELECT COUNT(*) AS totalCount FROM projection_threads t
      WHERE ${activeOrganizationThreadsSql(sql, state)}
    `,
  });

  return (input) => {
    const limit = clamp(input.limit ?? ORGANIZATION_THREAD_SUMMARY_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: ORGANIZATION_THREAD_SUMMARY_MAX_LIMIT,
    });
    return sql
      .withTransaction(
        Effect.all({
          sequence: readProjectionSequence(),
          count: input.includeTotalCount ? readCount(input.state) : Effect.void,
          rows: readThreads({
            state: input.state,
            limit: limit + 1,
            // Legacy cursors carry no sort key; their `updatedAt` is the closest bound.
            cursorSortKey: input.cursor ? (input.cursor.sortKey ?? input.cursor.updatedAt) : null,
            cursorThreadId: input.cursor?.threadId ?? null,
          }),
        }),
      )
      .pipe(
        Effect.map(({ rows, sequence, count }) => {
          const threads = rows.slice(0, limit).map(normalizeThreadSummary);
          const last = threads.at(-1);
          return {
            projectionSequence: sequence,
            state: input.state,
            threads,
            ...(count ? { totalCount: count.totalCount } : {}),
            ...(rows.length > limit && last
              ? { nextCursor: nextSortedThreadCursor(last, "updated_at") }
              : {}),
          };
        }),
        Effect.mapError(
          toPersistenceSqlError("ProjectionCatalogQuery.getOrganizationThreadSummaries"),
        ),
      );
  };
}
