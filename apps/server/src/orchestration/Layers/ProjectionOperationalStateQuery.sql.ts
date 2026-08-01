import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  ProjectionProjectDbRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadTaskDbRowSchema,
} from "./ProjectionSnapshotQuerySql.schemas.ts";

export const STARTUP_OPERATIONAL_MESSAGE_LIMIT = 50;
export const STARTUP_OPERATIONAL_ACTIVITY_LIMIT = 100;

export function makeStartupOperationalWindowSql(sql: SqlClient.SqlClient) {
  const operationalThreadPredicate = sql`
    EXISTS (
      SELECT 1 FROM projection_thread_sessions s
      WHERE s.thread_id = t.thread_id AND s.status IN ('starting', 'running')
    )
    OR EXISTS (
      SELECT 1 FROM projection_pending_approvals p
      WHERE p.thread_id = t.thread_id AND p.status = 'pending'
    )
    OR EXISTS (
      SELECT 1 FROM projection_pending_user_inputs u
      WHERE u.thread_id = t.thread_id AND u.status = 'pending'
    )
    OR EXISTS (
      SELECT 1 FROM projection_thread_tasks k
      WHERE k.thread_id = t.thread_id
        AND json_extract(k.task_json, '$.status') IN ('pending', 'inProgress')
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
    OR t.pinned_at IS NOT NULL
    OR json_array_length(t.queued_prompts_json) > 0
  `;

  const listOperationalThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () => sql`
      SELECT
        t.thread_id AS "threadId", t.project_id AS "projectId", t.title, t.purpose,
        COALESCE(t.elevator_summary, t.title) AS "elevatorSummary",
        t.elevator_summary_message_count AS "elevatorSummaryMessageCount",
        t.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        t.workspace_execution_target_id AS "workspaceExecutionTargetId",
        t.execution_target_id AS "executionTargetId", t.model_selection_json AS "modelSelection",
        t.runtime_mode AS "runtimeMode", t.interaction_mode AS "interactionMode", t.branch,
        t.worktree_path AS "worktreePath",
        CASE WHEN t.parent_thread_id IS NULL OR t.parent_thread_title IS NULL THEN NULL ELSE json_object(
          'threadId', t.parent_thread_id, 'title', t.parent_thread_title,
          'projectId', COALESCE(t.parent_thread_project_id, t.project_id)
        ) END AS "parentThread",
        t.latest_turn_id AS "latestTurnId", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
        t.queued_prompts_json AS "queuedPrompts",
        t.archived_at AS "archivedAt", t.pinned_at AS "pinnedAt", t.deleting_at AS "deletingAt",
        t.deleted_at AS "deletedAt"
      FROM projection_threads t
      WHERE ${operationalThreadPredicate}
      ORDER BY t.created_at ASC, t.thread_id ASC
    `,
  });

  const listOperationalProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () => sql`
      SELECT
        p.project_id AS "projectId", p.title,
        p.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        p.workspace_execution_target_id AS "workspaceExecutionTargetId",
        p.execution_target_id AS "executionTargetId", p.workspace_root AS "workspaceRoot",
        p.default_model_selection_json AS "defaultModelSelection", p.scripts_json AS scripts,
        p.created_at AS "createdAt", p.updated_at AS "updatedAt",
        p.deleting_at AS "deletingAt", p.deleted_at AS "deletedAt"
      FROM projection_projects p
      WHERE EXISTS (
        SELECT 1 FROM projection_threads t WHERE t.project_id = p.project_id
          AND ${operationalThreadPredicate}
      )
      ORDER BY p.created_at ASC, p.project_id ASC
    `,
  });

  const listActiveThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () => sql`
      WITH ranked AS (
        SELECT
          m.message_id AS "messageId",
          m.thread_id AS "threadId",
          m.turn_id AS "turnId",
          m.role,
          m.text,
          m.attachments_json AS "attachments",
          m.reply_to_json AS "replyTo",
          m.is_streaming AS "isStreaming",
          m.created_at AS "createdAt",
          m.updated_at AS "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY m.thread_id
            ORDER BY m.created_at DESC, m.message_id DESC
          ) AS row_number
        FROM projection_thread_messages m
        LEFT JOIN projection_thread_sessions s ON s.thread_id = m.thread_id
        WHERE s.status IN ('starting', 'running')
          OR EXISTS (
            SELECT 1 FROM projection_pending_approvals p
            WHERE p.thread_id = m.thread_id AND p.status = 'pending'
          )
          OR EXISTS (
            SELECT 1 FROM projection_pending_user_inputs u
            WHERE u.thread_id = m.thread_id AND u.status = 'pending'
          )
      )
      SELECT
        "messageId", "threadId", "turnId", role, text, attachments, "replyTo",
        "isStreaming", "createdAt", "updatedAt"
      FROM ranked
      WHERE row_number <= ${STARTUP_OPERATIONAL_MESSAGE_LIMIT}
      ORDER BY "threadId" ASC, "createdAt" ASC, "messageId" ASC
    `,
  });

  const listActiveThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () => sql`
      WITH ranked AS (
        SELECT
          a.activity_id AS "activityId",
          a.thread_id AS "threadId",
          a.turn_id AS "turnId",
          a.tone,
          a.kind,
          a.summary,
          a.payload_json AS "payload",
          a.sequence,
          a.created_at AS "createdAt",
          ROW_NUMBER() OVER (
            PARTITION BY a.thread_id
            ORDER BY
              CASE WHEN a.sequence IS NULL THEN 0 ELSE 1 END DESC,
              a.sequence DESC,
              a.created_at DESC,
              a.activity_id DESC
          ) AS row_number
        FROM projection_thread_activities a
        LEFT JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
        WHERE s.status IN ('starting', 'running')
          OR EXISTS (
            SELECT 1 FROM projection_pending_approvals p
            WHERE p.thread_id = a.thread_id AND p.status = 'pending'
          )
          OR EXISTS (
            SELECT 1 FROM projection_pending_user_inputs u
            WHERE u.thread_id = a.thread_id AND u.status = 'pending'
          )
      )
      SELECT
        "activityId", "threadId", "turnId", tone, kind, summary, payload,
        sequence, "createdAt"
      FROM ranked
      WHERE row_number <= ${STARTUP_OPERATIONAL_ACTIVITY_LIMIT}
        OR (
          kind = 'approval.requested'
          AND EXISTS (
            SELECT 1 FROM projection_pending_approvals p
            WHERE p.thread_id = ranked."threadId"
              AND p.request_id = json_extract(ranked.payload, '$.requestId')
              AND p.status = 'pending'
          )
        )
        OR (
          kind = 'user-input.requested'
          AND EXISTS (
            SELECT 1 FROM projection_pending_user_inputs u
            WHERE u.thread_id = ranked."threadId"
              AND u.request_id = json_extract(ranked.payload, '$.requestId')
              AND u.status = 'pending'
          )
        )
      ORDER BY
        "threadId" ASC,
        CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
        sequence ASC,
        "createdAt" ASC,
        "activityId" ASC
    `,
  });

  const listActiveThreadTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadTaskDbRowSchema,
    execute: () => sql`
      SELECT
        task_id AS "taskId", thread_id AS "threadId", task_json AS task,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_tasks
      WHERE json_extract(task_json, '$.status') IN ('pending', 'inProgress')
      ORDER BY thread_id ASC, created_at ASC, task_id ASC
    `,
  });

  return {
    listOperationalProjectRows,
    listOperationalThreadRows,
    listActiveThreadMessageRows,
    listActiveThreadActivityRows,
    listActiveThreadTaskRows,
  };
}
