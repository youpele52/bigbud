import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import { FAVORITE_THREAD_LIMIT } from "@bigbud/contracts/constants/settings.constant.ts";
import { SIDEBAR_THREAD_CATALOG_RECENT_LIMIT } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectionCatalogQueryShape } from "../Services/ProjectionCatalogQuery.ts";
import {
  SidebarThreadSummaryDbRow,
  normalizeThreadSummary,
} from "./ProjectionCatalogQuery.schemas.ts";

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
      SELECT
        t.thread_id AS id, t.project_id AS "projectId", t.title, t.purpose,
        COALESCE(t.elevator_summary, t.title) AS "elevatorSummary",
        t.model_selection_json AS "modelSelection", t.runtime_mode AS "runtimeMode",
        t.interaction_mode AS "interactionMode",
        t.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        t.workspace_execution_target_id AS "workspaceExecutionTargetId",
        t.execution_target_id AS "executionTargetId", t.branch,
        t.worktree_path AS "worktreePath", t.created_at AS "createdAt",
        t.updated_at AS "updatedAt",
        (SELECT MAX(m.created_at) FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.role = 'user') AS "latestUserMessageAt",
        t.pinned_at AS "pinnedAt", s.status AS "sessionStatus",
        s.provider_name AS "providerName", s.active_turn_id AS "activeTurnId",
        turn.state AS "latestTurnState",
        EXISTS (SELECT 1 FROM projection_thread_watches w
          WHERE w.watcher_thread_id = t.thread_id AND w.status = 'active') AS "isWatching",
        EXISTS (SELECT 1 FROM projection_thread_watches w
          WHERE w.watched_thread_id = t.thread_id AND w.status = 'active') AS "isWatched",
        EXISTS (SELECT 1 FROM thread_delegations d
          WHERE (d.caller_thread_id = t.thread_id OR d.child_thread_id = t.thread_id)
            AND d.state NOT IN ('completed', 'compensated', 'failed')) AS "isDelegated",
        EXISTS (SELECT 1 FROM projection_pending_approvals a
          WHERE a.thread_id = t.thread_id AND a.status = 'pending') AS "isAwaitingApproval",
        membership.is_recent AS "isRecent", membership.is_pinned AS "isPinned"
      FROM membership
      JOIN projection_threads t ON t.thread_id = membership.thread_id
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN projection_turns turn
        ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
    `,
  });

  return () =>
    sql
      .withTransaction(
        Effect.all({
          sequence: readProjectionSequence(),
          rows: readSidebarThreads(undefined),
        }),
      )
      .pipe(
        Effect.map(({ rows, sequence }) => ({
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
        })),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getSidebarThreadCatalog")),
      );
}
