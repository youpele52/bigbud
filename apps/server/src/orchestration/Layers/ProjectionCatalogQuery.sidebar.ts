import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { FAVORITE_THREAD_LIMIT } from "@bigbud/contracts/constants/settings.constant.ts";
import { SIDEBAR_THREAD_CATALOG_RECENT_LIMIT } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectionCatalogQueryShape } from "../Services/ProjectionCatalogQuery.ts";
import {
  ProjectThreadCountDbRow,
  SidebarThreadSummaryDbRow,
  normalizeThreadSummary,
} from "./ProjectionCatalogQuery.schemas.ts";
import {
  threadSummaryColumnsSql,
  threadSummaryJoinsSql,
} from "./ProjectionCatalogQuery.summaryColumns.ts";

export function makeGetSidebarThreadCatalog(
  sql: SqlClient.SqlClient,
  readProjectionSequence: () => Effect.Effect<number, ProjectionRepositoryError>,
): ProjectionCatalogQueryShape["getSidebarThreadCatalog"] {
  const readSidebarThreads = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SidebarThreadSummaryDbRow,
    execute: () => sql`
      WITH recent_by_activity AS (
        SELECT t.thread_id
        FROM projection_threads t
        WHERE t.project_id = ${BUILT_IN_CHATS_PROJECT_ID}
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.deleting_at IS NULL
        ORDER BY COALESCE((
          SELECT MAX(m.created_at)
          FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.role = 'user'
        ), t.created_at) DESC, t.thread_id DESC
        LIMIT ${SIDEBAR_THREAD_CATALOG_RECENT_LIMIT}
      ), recent_by_created AS (
        SELECT t.thread_id
        FROM projection_threads t
        WHERE t.project_id = ${BUILT_IN_CHATS_PROJECT_ID}
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.deleting_at IS NULL
        ORDER BY t.created_at DESC, t.thread_id DESC
        LIMIT ${SIDEBAR_THREAD_CATALOG_RECENT_LIMIT}
      ), pinned AS (
        SELECT t.thread_id
        FROM projection_threads t
        WHERE t.pinned_at IS NOT NULL
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.deleting_at IS NULL
        ORDER BY t.pinned_at DESC, t.thread_id ASC
        LIMIT ${FAVORITE_THREAD_LIMIT}
      ), candidates AS (
        SELECT thread_id, 1 AS is_recent, 0 AS is_pinned FROM recent_by_activity
        UNION ALL
        SELECT thread_id, 1 AS is_recent, 0 AS is_pinned FROM recent_by_created
        UNION ALL
        SELECT thread_id, 0 AS is_recent, 1 AS is_pinned FROM pinned
      ), membership AS (
        SELECT thread_id, MAX(is_recent) AS is_recent, MAX(is_pinned) AS is_pinned
        FROM candidates
        GROUP BY thread_id
      )
      SELECT ${threadSummaryColumnsSql(sql)},
        membership.is_recent AS "isRecent", membership.is_pinned AS "isPinned"
      FROM membership
      JOIN projection_threads t ON t.thread_id = membership.thread_id
      ${threadSummaryJoinsSql(sql)}
    `,
  });

  const readProjectThreadCounts = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectThreadCountDbRow,
    execute: () => sql`
      SELECT p.project_id AS "projectId", COUNT(t.thread_id) AS "threadCount"
      FROM projection_projects p
      LEFT JOIN projection_threads t
        ON t.project_id = p.project_id
        AND t.purpose = 'standard'
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND t.deleting_at IS NULL
      WHERE p.deleted_at IS NULL
      GROUP BY p.project_id
    `,
  });

  return () =>
    sql
      .withTransaction(
        Effect.all({
          sequence: readProjectionSequence(),
          rows: readSidebarThreads(undefined),
          projectThreadCounts: readProjectThreadCounts(undefined),
        }),
      )
      .pipe(
        Effect.map(({ projectThreadCounts, rows, sequence }) => ({
          projectionSequence: sequence,
          threads: rows.map(({ isRecent: _, isPinned: __, ...thread }) =>
            normalizeThreadSummary(thread),
          ),
          recentThreadIds: rows.filter((row) => row.isRecent === 1).map((row) => row.id),
          pinnedThreadIds: rows
            .filter((row) => row.isPinned === 1)
            .toSorted(
              (left, right) =>
                (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
                left.id.localeCompare(right.id),
            )
            .map((row) => row.id),
          projectThreadCounts,
        })),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getSidebarThreadCatalog")),
      );
}
