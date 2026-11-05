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

const OrganizationPageRequest = Schema.Struct({
  state: Schema.String,
  limit: Schema.Number,
  cursorUpdatedAt: Schema.NullOr(Schema.String),
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
 * One keyset page of active threads in an Inyosira state across every project, served by the
 * partial index from migration 142.
 */
export function makeGetOrganizationThreadSummaries(
  sql: SqlClient.SqlClient,
  readProjectionSequence: () => Effect.Effect<number, ProjectionRepositoryError>,
): ProjectionCatalogQueryShape["getOrganizationThreadSummaries"] {
  const readThreads = SqlSchema.findAll({
    Request: OrganizationPageRequest,
    Result: ThreadSummaryDbRow,
    execute: ({ state, limit, cursorUpdatedAt, cursorThreadId }) => sql`
      SELECT ${threadSummaryColumnsSql(sql)}
      FROM projection_threads t
      ${threadSummaryJoinsSql(sql)}
      WHERE ${activeOrganizationThreadsSql(sql, state)}
        AND (
          ${cursorUpdatedAt} IS NULL
          OR t.updated_at < ${cursorUpdatedAt}
          OR (t.updated_at = ${cursorUpdatedAt} AND t.thread_id > ${cursorThreadId})
        )
      ORDER BY t.updated_at DESC, t.thread_id ASC
      LIMIT ${limit}
    `,
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
            cursorUpdatedAt: input.cursor?.updatedAt ?? null,
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
              ? { nextCursor: { updatedAt: last.updatedAt, threadId: last.id } }
              : {}),
          };
        }),
        Effect.mapError(
          toPersistenceSqlError("ProjectionCatalogQuery.getOrganizationThreadSummaries"),
        ),
      );
  };
}
