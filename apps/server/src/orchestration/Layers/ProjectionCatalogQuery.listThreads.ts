import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type {
  CatalogThreadRow,
  ProjectionCatalogQueryShape,
} from "../Services/ProjectionCatalogQuery.ts";

const Request = Schema.Struct({
  callerThreadId: Schema.String,
  requestedProjectId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["active", "archived", "all"]),
  limit: Schema.Number,
  includeExcerpt: Schema.Boolean,
});

const ContextRow = Schema.Struct({
  callerProjectId: ProjectId,
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(Schema.String),
});

const CountRow = Schema.Struct({ totalCount: Schema.Number });

const Row = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  workflowStatus: Schema.String,
  isAgentActive: Schema.Number,
  isWorkflowComplete: Schema.Number,
  archived: Schema.Number,
  pinned: Schema.Number,
  deleting: Schema.Number,
  purpose: Schema.String,
  parentThreadId: Schema.NullOr(ThreadId),
  latestTurnState: Schema.NullOr(Schema.String),
  hasPendingApprovals: Schema.Number,
  hasPendingUserInput: Schema.Number,
  messageCount: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastAssistantExcerpt: Schema.NullOr(Schema.String),
});

type Request = typeof Request.Type;
type Row = typeof Row.Type;

const statusPredicate = (status: Request["status"]) =>
  status === "active"
    ? "AND t.purpose = 'standard' AND t.archived_at IS NULL AND t.deleting_at IS NULL"
    : status === "archived"
      ? "AND t.archived_at IS NOT NULL"
      : "";

const workflowStatusExpression = `
  CASE
    WHEN t.archived_at IS NOT NULL THEN 'archived'
    WHEN s.status = 'error' OR turn.state = 'error' THEN 'error'
    WHEN t.pending_approval_count > 0 THEN 'awaiting_approval'
    WHEN t.pending_user_input_count > 0 THEN 'awaiting_input'
    WHEN s.status = 'starting' THEN 'connecting'
    WHEN s.status = 'running' AND s.reason = 'context.compacting' THEN 'compacting'
    WHEN s.status = 'running' THEN 'working'
    WHEN t.interaction_mode = 'plan' AND t.has_actionable_proposed_plan = 1
      AND (turn.turn_id IS NULL OR (
        turn.started_at IS NOT NULL AND turn.completed_at IS NOT NULL
      )) THEN 'plan_ready'
    WHEN turn.state = 'completed' AND t.has_actionable_proposed_plan = 0
      AND turn.started_at IS NOT NULL AND turn.completed_at IS NOT NULL
      THEN 'workflow_complete'
    ELSE 'idle'
  END
`;

function normalizeRow(row: Row, includeExcerpt: boolean): CatalogThreadRow {
  const { lastAssistantExcerpt, ...rest } = row;
  return {
    ...rest,
    workflowStatus: row.workflowStatus as CatalogThreadRow["workflowStatus"],
    isAgentActive: row.isAgentActive === 1,
    isWorkflowComplete: row.isWorkflowComplete === 1,
    archived: row.archived === 1,
    pinned: row.pinned === 1,
    deleting: row.deleting === 1,
    purpose: row.purpose as CatalogThreadRow["purpose"],
    latestTurnState: row.latestTurnState as CatalogThreadRow["latestTurnState"],
    hasPendingApprovals: row.hasPendingApprovals === 1,
    hasPendingUserInput: row.hasPendingUserInput === 1,
    ...(includeExcerpt ? { lastAssistantExcerpt } : {}),
  };
}

export function makeListThreads(
  sql: SqlClient.SqlClient,
): ProjectionCatalogQueryShape["listThreads"] {
  const readContext = SqlSchema.findOne({
    Request,
    Result: ContextRow,
    execute: ({ callerThreadId, requestedProjectId }) => sql`
      SELECT caller.project_id AS "callerProjectId", project.project_id AS "projectId",
        project.title AS "projectTitle"
      FROM projection_threads caller
      LEFT JOIN projection_projects project
        ON project.project_id = COALESCE(${requestedProjectId}, caller.project_id)
        AND project.deleted_at IS NULL
      WHERE caller.thread_id = ${callerThreadId} AND caller.deleted_at IS NULL
    `,
  });

  const readCount = SqlSchema.findOne({
    Request,
    Result: CountRow,
    execute: (request) =>
      sql.unsafe(
        `
      SELECT COUNT(*) AS "totalCount" FROM projection_threads t
      WHERE t.project_id = ? AND t.deleted_at IS NULL ${statusPredicate(request.status)}
    `,
        [request.requestedProjectId],
      ),
  });

  const readRows = SqlSchema.findAll({
    Request,
    Result: Row,
    execute: (request) =>
      sql.unsafe(
        `
      WITH projected AS (
      SELECT t.thread_id AS "threadId", t.title,
        ${workflowStatusExpression} AS "workflowStatus",
        t.archived_at IS NOT NULL AS archived, t.pinned_at IS NOT NULL AS pinned,
        t.deleting_at IS NOT NULL AS deleting, t.purpose, t.parent_thread_id AS "parentThreadId",
        turn.state AS "latestTurnState", t.pending_approval_count > 0 AS "hasPendingApprovals",
        t.pending_user_input_count > 0 AS "hasPendingUserInput",
        (SELECT COUNT(*) FROM projection_thread_messages m WHERE m.thread_id = t.thread_id)
          AS "messageCount",
        t.created_at AS "createdAt", t.updated_at AS "updatedAt",
        CASE WHEN ? THEN (SELECT CASE WHEN length(trim(m.text)) > 240
          THEN substr(trim(m.text), 1, 237) || '...' ELSE trim(m.text) END
          FROM projection_thread_messages m WHERE m.thread_id = t.thread_id
            AND m.role = 'assistant' AND m.is_streaming = 0 AND length(trim(m.text)) > 0
          ORDER BY m.created_at DESC, m.message_id DESC LIMIT 1) ELSE NULL END
          AS "lastAssistantExcerpt"
      FROM projection_threads t
      LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      LEFT JOIN projection_turns turn ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
      WHERE t.project_id = ? AND t.deleted_at IS NULL ${statusPredicate(request.status)}
      )
      SELECT projected.*,
        "workflowStatus" IN ('connecting', 'compacting', 'working') AS "isAgentActive",
        "workflowStatus" = 'workflow_complete' AS "isWorkflowComplete"
      FROM projected
      ORDER BY "updatedAt" DESC, "threadId" ASC LIMIT ?
    `,
        [request.includeExcerpt ? 1 : 0, request.requestedProjectId, request.limit],
      ),
  });

  return (input) => {
    const base = { ...input, requestedProjectId: input.projectId ?? null };
    return readContext(base).pipe(
      Effect.flatMap((context) => {
        if (!context.projectId) {
          return Effect.succeed({
            callerResolved: true,
            projectId: null,
            projectTitle: null,
            totalCount: 0,
            threads: [],
          });
        }
        const request = { ...base, requestedProjectId: context.projectId };
        return sql
          .withTransaction(Effect.all({ count: readCount(request), rows: readRows(request) }))
          .pipe(
            Effect.map(({ count, rows }) => ({
              callerResolved: true,
              projectId: context.projectId,
              projectTitle: context.projectTitle,
              totalCount: count.totalCount,
              threads: rows.map((row) => normalizeRow(row, input.includeExcerpt)),
            })),
          );
      }),
      Effect.catchTag("NoSuchElementError", () =>
        Effect.succeed({
          callerResolved: false,
          projectId: null,
          projectTitle: null,
          totalCount: 0,
          threads: [],
        }),
      ),
      Effect.mapError(toPersistenceSqlError("ProjectionCatalogQuery.listThreads")),
    );
  };
}
