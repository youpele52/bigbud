import {
  PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT,
  PROJECT_THREAD_SUMMARY_MAX_LIMIT,
  STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT,
  STARTUP_PROJECT_CATALOG_MAX_LIMIT,
  type GetProjectThreadSummariesInput,
  type ProjectSummary,
} from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import { Effect, Layer, Schema } from "effect";
import { clamp } from "effect/Number";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  ProjectionCatalogQuery,
  type ProjectionCatalogQueryShape,
} from "../Services/ProjectionCatalogQuery.ts";
import {
  ProjectCatalogDbRow,
  ProjectionSequenceDbRow,
  ThreadSummaryDbRow,
  normalizeThreadSummary,
} from "./ProjectionCatalogQuery.schemas.ts";
import { makeGetSelectedThreadDetail } from "./ProjectionCatalogQuery.detail.ts";
import { makeGetSidebarThreadCatalog } from "./ProjectionCatalogQuery.sidebar.ts";
import { makeListThreads } from "./ProjectionCatalogQuery.listThreads.ts";

const ProjectCatalogQueryRequest = Schema.Struct({
  scope: Schema.Literals(["local", "remote"]),
  limit: Schema.Number,
  query: Schema.NullOr(Schema.String),
  priorityProjectId: Schema.NullOr(Schema.String),
  cursorLastUsedAt: Schema.NullOr(Schema.String),
  cursorProjectId: Schema.NullOr(Schema.String),
});

const ProjectCatalogCountDbRow = Schema.Struct({
  count: Schema.Number,
});

const ThreadSummaryQueryRequest = Schema.Struct({
  projectId: Schema.String,
  limit: Schema.Number,
  priorityThreadId: Schema.NullOr(Schema.String),
  cursorUpdatedAt: Schema.NullOr(Schema.String),
  cursorThreadId: Schema.NullOr(Schema.String),
});

function normalizeProject(row: ProjectCatalogDbRow): ProjectSummary {
  return { ...row, hasExceptionalThreads: row.hasExceptionalThreads === 1 };
}

const makeProjectionCatalogQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readProjectionSequence = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionSequenceDbRow,
    execute: () =>
      sql`SELECT MIN(last_applied_sequence) AS "projectionSequence" FROM projection_state`,
  });

  const readProjects = SqlSchema.findAll({
    Request: ProjectCatalogQueryRequest,
    Result: ProjectCatalogDbRow,
    execute: ({ scope, limit, query, priorityProjectId, cursorLastUsedAt, cursorProjectId }) => {
      const scopePredicate = sql.unsafe(
        scope === "local"
          ? "workspace_execution_target_id = 'local'"
          : "workspace_execution_target_id <> 'local'",
      );
      const pageOrderBy =
        priorityProjectId === null
          ? sql.unsafe("last_used_at DESC, project_id ASC")
          : sql`CASE WHEN project_id = ${priorityProjectId} THEN 0 ELSE 1 END,
              last_used_at DESC, project_id ASC`;
      const resultOrderBy =
        priorityProjectId === null
          ? sql.unsafe("p.last_used_at DESC, p.project_id ASC")
          : sql`CASE WHEN p.project_id = ${priorityProjectId} THEN 0 ELSE 1 END,
              p.last_used_at DESC, p.project_id ASC`;
      return sql`
        WITH page AS (
        SELECT *
        FROM projection_projects
        WHERE deleted_at IS NULL
          AND (${query} IS NULL OR deleting_at IS NULL)
          AND ${scopePredicate}
           AND (${query} IS NULL OR instr(lower(title), lower(${query})) > 0)
          AND (
            ${cursorLastUsedAt} IS NULL
            OR ${priorityProjectId} IS NULL
            OR project_id != ${priorityProjectId}
          )
          AND (
            ${cursorLastUsedAt} IS NULL
            OR last_used_at < ${cursorLastUsedAt}
            OR (last_used_at = ${cursorLastUsedAt} AND project_id > ${cursorProjectId})
          )
        ORDER BY ${pageOrderBy}
        LIMIT ${limit}
      ), stats AS (
        SELECT
          p.project_id,
          COUNT(t.thread_id) AS thread_count,
          COALESCE(SUM(CASE WHEN
            t.thread_id IS NOT NULL
            AND (
              t.pinned_at IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM projection_thread_sessions s
                WHERE s.thread_id = t.thread_id AND s.status IN ('starting', 'running')
              )
              OR EXISTS (
                SELECT 1 FROM projection_pending_approvals a
                WHERE a.thread_id = t.thread_id AND a.status = 'pending'
              )
              OR EXISTS (
                SELECT 1 FROM projection_thread_watches w
                WHERE (w.watcher_thread_id = t.thread_id OR w.watched_thread_id = t.thread_id)
                  AND w.status = 'active'
              )
              OR EXISTS (
                SELECT 1 FROM thread_delegations d
                WHERE (d.caller_thread_id = t.thread_id OR d.child_thread_id = t.thread_id)
                  AND d.state NOT IN ('completed', 'compensated', 'failed')
              )
            )
            THEN 1 ELSE 0 END), 0) AS exceptional_thread_count
        FROM page p
        LEFT JOIN projection_threads t
          ON t.project_id = p.project_id
          AND t.purpose = 'standard'
          AND t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND t.deleting_at IS NULL
        GROUP BY p.project_id
      )
      SELECT
        p.project_id AS id,
        p.title,
        p.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        p.workspace_execution_target_id AS "workspaceExecutionTargetId",
        p.execution_target_id AS "executionTargetId",
        p.workspace_root AS "workspaceRoot",
        p.last_used_at AS "lastUsedAt",
        p.updated_at AS "updatedAt",
        p.deleting_at AS "deletingAt",
        stats.thread_count AS "threadCount",
        stats.exceptional_thread_count AS "exceptionalThreadCount",
        CASE WHEN stats.exceptional_thread_count > 0 THEN 1 ELSE 0 END AS "hasExceptionalThreads"
      FROM page p
      JOIN stats ON stats.project_id = p.project_id
      ORDER BY ${resultOrderBy}
      `;
    },
  });

  const countProjects = SqlSchema.findOne({
    Request: ProjectCatalogQueryRequest,
    Result: ProjectCatalogCountDbRow,
    execute: ({ scope, query, priorityProjectId, cursorLastUsedAt, cursorProjectId }) => {
      const scopePredicate = sql.unsafe(
        scope === "local"
          ? "workspace_execution_target_id = 'local'"
          : "workspace_execution_target_id <> 'local'",
      );
      return sql`
        SELECT COUNT(*) AS count
        FROM projection_projects
        WHERE deleted_at IS NULL
          AND (${query} IS NULL OR deleting_at IS NULL)
          AND ${scopePredicate}
           AND (${query} IS NULL OR instr(lower(title), lower(${query})) > 0)
          AND (
            ${cursorLastUsedAt} IS NULL
            OR ${priorityProjectId} IS NULL
            OR project_id != ${priorityProjectId}
          )
          AND (
            ${cursorLastUsedAt} IS NULL
            OR last_used_at < ${cursorLastUsedAt}
            OR (last_used_at = ${cursorLastUsedAt} AND project_id > ${cursorProjectId})
          )
      `;
    },
  });

  const readThreads = SqlSchema.findAll({
    Request: ThreadSummaryQueryRequest,
    Result: ThreadSummaryDbRow,
    execute: ({ projectId, limit, priorityThreadId, cursorUpdatedAt, cursorThreadId }) => sql`
      SELECT
        t.thread_id AS id,
        t.project_id AS "projectId",
        t.title,
        t.purpose,
        COALESCE(t.elevator_summary, t.title) AS "elevatorSummary",
        t.model_selection_json AS "modelSelection",
        t.runtime_mode AS "runtimeMode",
        t.interaction_mode AS "interactionMode",
        t.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        t.workspace_execution_target_id AS "workspaceExecutionTargetId",
        t.execution_target_id AS "executionTargetId",
        t.branch,
        t.worktree_path AS "worktreePath",
        t.created_at AS "createdAt",
        t.updated_at AS "updatedAt",
        (
          SELECT MAX(m.created_at)
          FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.role = 'user'
        ) AS "latestUserMessageAt",
        t.pinned_at AS "pinnedAt",
        s.status AS "sessionStatus",
        s.provider_name AS "providerName",
        s.active_turn_id AS "activeTurnId",
        turn.state AS "latestTurnState",
        EXISTS (
          SELECT 1 FROM projection_thread_watches w
          WHERE w.watcher_thread_id = t.thread_id AND w.status = 'active'
        ) AS "isWatching",
        EXISTS (
          SELECT 1 FROM projection_thread_watches w
          WHERE w.watched_thread_id = t.thread_id AND w.status = 'active'
        ) AS "isWatched",
        EXISTS (
          SELECT 1 FROM thread_delegations d
          WHERE (d.caller_thread_id = t.thread_id OR d.child_thread_id = t.thread_id)
            AND d.state NOT IN ('completed', 'compensated', 'failed')
        ) AS "isDelegated",
        EXISTS (
          SELECT 1 FROM projection_pending_approvals a
          WHERE a.thread_id = t.thread_id AND a.status = 'pending'
        ) AS "isAwaitingApproval"
      FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN projection_turns turn
        ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
      WHERE t.project_id = ${projectId}
        AND t.purpose = 'standard'
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND t.deleting_at IS NULL
        AND (
          ${cursorUpdatedAt} IS NULL
          OR ${priorityThreadId} IS NULL
          OR t.thread_id != ${priorityThreadId}
        )
        AND (
          ${cursorUpdatedAt} IS NULL
          OR t.updated_at < ${cursorUpdatedAt}
          OR (t.updated_at = ${cursorUpdatedAt} AND t.thread_id > ${cursorThreadId})
        )
       ORDER BY CASE WHEN t.thread_id = ${priorityThreadId} THEN 0 ELSE 1 END,
         t.updated_at DESC, t.thread_id ASC
      LIMIT ${limit}
    `,
  });

  const getStartupProjectCatalog: ProjectionCatalogQueryShape["getStartupProjectCatalog"] = (
    input,
  ) => {
    const limit = clamp(input.limit ?? STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: STARTUP_PROJECT_CATALOG_MAX_LIMIT,
    });
    return sql
      .withTransaction(
        Effect.all({
          sequence: readProjectionSequence(undefined),
          rows: readProjects({
            scope: input.scope,
            limit: limit + 1,
            query: input.query ?? null,
            priorityProjectId: input.priorityProjectId ?? null,
            cursorLastUsedAt: input.cursor?.lastUsedAt ?? null,
            cursorProjectId: input.cursor?.projectId ?? null,
          }),
          count: countProjects({
            scope: input.scope,
            limit: limit + 1,
            query: input.query ?? null,
            priorityProjectId: input.priorityProjectId ?? null,
            cursorLastUsedAt: input.cursor?.lastUsedAt ?? null,
            cursorProjectId: input.cursor?.projectId ?? null,
          }),
        }),
      )
      .pipe(
        Effect.map(({ rows, count, sequence }) => {
          const projects = rows.slice(0, limit).map(normalizeProject);
          const last = projects.at(-1);
          const remainingCount = Math.max(count.count - projects.length, 0);
          return {
            projectionSequence: sequence.projectionSequence ?? 0,
            projects,
            remainingCount,
            ...(remainingCount > 0 && last
              ? { nextCursor: { lastUsedAt: last.lastUsedAt, projectId: last.id } }
              : {}),
          };
        }),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getStartupProjectCatalog")),
      );
  };

  const getProjectThreadSummaries: ProjectionCatalogQueryShape["getProjectThreadSummaries"] = (
    input: GetProjectThreadSummariesInput,
  ) => {
    const limit = clamp(input.limit ?? PROJECT_THREAD_SUMMARY_DEFAULT_LIMIT, {
      minimum: 1,
      maximum: PROJECT_THREAD_SUMMARY_MAX_LIMIT,
    });
    return sql
      .withTransaction(
        Effect.all({
          sequence: readProjectionSequence(undefined),
          rows: readThreads({
            projectId: input.projectId,
            limit: limit + 1,
            priorityThreadId: input.priorityThreadId ?? null,
            cursorUpdatedAt: input.cursor?.updatedAt ?? null,
            cursorThreadId: input.cursor?.threadId ?? null,
          }),
        }),
      )
      .pipe(
        Effect.map(({ rows, sequence }) => {
          const threads = rows.slice(0, limit).map(normalizeThreadSummary);
          const last = threads.at(-1);
          return {
            projectionSequence: sequence.projectionSequence ?? 0,
            projectId: input.projectId,
            threads,
            ...(rows.length > limit && last
              ? { nextCursor: { updatedAt: last.updatedAt, threadId: last.id } }
              : {}),
          };
        }),
        Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getProjectThreadSummaries")),
      );
  };

  const getSelectedThreadDetail = makeGetSelectedThreadDetail(sql, () =>
    readProjectionSequence(undefined).pipe(
      Effect.map((row) => row.projectionSequence ?? 0),
      Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getSelectedThreadDetail")),
    ),
  );
  const getSidebarThreadCatalog = makeGetSidebarThreadCatalog(sql, () =>
    readProjectionSequence(undefined).pipe(
      Effect.map((row) => row.projectionSequence ?? 0),
      Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.getSidebarThreadCatalog")),
    ),
  );
  const listThreads = makeListThreads(sql);

  return {
    listThreads,
    getSidebarThreadCatalog,
    getStartupProjectCatalog,
    getProjectThreadSummaries,
    getSelectedThreadDetail,
  } satisfies ProjectionCatalogQueryShape;
});

export const ProjectionCatalogQueryLive = Layer.effect(
  ProjectionCatalogQuery,
  makeProjectionCatalogQuery,
);
