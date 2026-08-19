import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  ProjectionCheckpointDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionProjectDbRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionThreadTaskDbRowSchema,
  ProjectionThreadWatchDbRowSchema,
} from "./ProjectionSnapshotQuerySql.schemas.ts";

const ThreadRequest = Schema.Struct({ threadId: Schema.String });
const ThreadWindowRequest = Schema.Struct({ threadId: Schema.String, limit: Schema.Number });

export function makeThreadOperationalStateSql(sql: SqlClient.SqlClient) {
  const listProjectRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionProjectDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        p.project_id AS "projectId", p.title,
        p.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        p.workspace_execution_target_id AS "workspaceExecutionTargetId",
        p.execution_target_id AS "executionTargetId", p.workspace_root AS "workspaceRoot",
        p.default_model_selection_json AS "defaultModelSelection", p.scripts_json AS scripts,
        p.created_at AS "createdAt", p.updated_at AS "updatedAt",
        p.deleting_at AS "deletingAt", p.deleted_at AS "deletedAt"
      FROM projection_projects p
      INNER JOIN projection_threads t ON t.project_id = p.project_id
      WHERE t.thread_id = ${threadId}
    `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId", project_id AS "projectId", title, purpose,
        COALESCE(elevator_summary, title) AS "elevatorSummary",
        elevator_summary_message_count AS "elevatorSummaryMessageCount",
        provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
        workspace_execution_target_id AS "workspaceExecutionTargetId",
        execution_target_id AS "executionTargetId", model_selection_json AS "modelSelection",
        runtime_mode AS "runtimeMode", interaction_mode AS "interactionMode", branch,
        worktree_path AS "worktreePath",
        CASE WHEN parent_thread_id IS NULL OR parent_thread_title IS NULL THEN NULL ELSE json_object(
          'threadId', parent_thread_id, 'title', parent_thread_title,
          'projectId', COALESCE(parent_thread_project_id, project_id)
        ) END AS "parentThread",
        latest_turn_id AS "latestTurnId", created_at AS "createdAt", updated_at AS "updatedAt",
        last_activity_at AS "lastActivityAt",
        queued_prompts_json AS "queuedPrompts",
        pending_interrupt_flush_intent_json AS "pendingInterruptFlushIntent",
        archived_at AS "archivedAt", pinned_at AS "pinnedAt", deleting_at AS "deletingAt",
        deleted_at AS "deletedAt"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: ThreadWindowRequest,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT * FROM (
        SELECT
          message_id AS "messageId", thread_id AS "threadId", turn_id AS "turnId", role, text,
          attachments_json AS attachments, reply_to_json AS "replyTo",
          is_streaming AS "isStreaming", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC, message_id DESC
        LIMIT ${limit}
      )
      ORDER BY "createdAt" ASC, "messageId" ASC
    `,
  });

  const listAllThreadMessageRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        message_id AS "messageId", thread_id AS "threadId", turn_id AS "turnId", role, text,
        attachments_json AS attachments, reply_to_json AS "replyTo",
        is_streaming AS "isStreaming", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, message_id ASC
    `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: ThreadWindowRequest,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, limit }) => sql`
      SELECT * FROM (
        SELECT
          activity_id AS "activityId", thread_id AS "threadId", turn_id AS "turnId",
          tone, kind, summary, payload_json AS payload, sequence, created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
          sequence DESC, created_at DESC, activity_id DESC
        LIMIT ${limit}
      )
      ORDER BY
        CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
        sequence ASC, "createdAt" ASC, "activityId" ASC
    `,
  });

  const listAllThreadActivityRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        activity_id AS "activityId", thread_id AS "threadId", turn_id AS "turnId",
        tone, kind, summary, payload_json AS payload, sequence, created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
      ORDER BY
        CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
        sequence ASC, created_at ASC, activity_id ASC
    `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId", thread_id AS "threadId", turn_id AS "turnId",
        plan_markdown AS "planMarkdown", implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const listThreadTaskRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadTaskDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT task_id AS "taskId", thread_id AS "threadId", task_json AS task,
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM projection_thread_tasks
      WHERE thread_id = ${threadId}
        AND json_extract(task_json, '$.status') IN ('pending', 'inProgress')
      ORDER BY created_at ASC, task_id ASC
    `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId", status, provider_name AS "providerName",
        provider_session_id AS "providerSessionId", provider_thread_id AS "providerThreadId",
        runtime_mode AS "runtimeMode", active_turn_id AS "activeTurnId", reason,
        last_error AS "lastError", updated_at AS "updatedAt"
      FROM projection_thread_sessions
      WHERE thread_id = ${threadId}
    `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId", turn_id AS "turnId",
        checkpoint_turn_count AS "checkpointTurnCount", checkpoint_ref AS "checkpointRef",
        checkpoint_status AS status, checkpoint_files_json AS files,
        assistant_message_id AS "assistantMessageId", completed_at AS "completedAt"
      FROM projection_turns
      WHERE thread_id = ${threadId} AND checkpoint_turn_count IS NOT NULL
      ORDER BY checkpoint_turn_count ASC
    `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        turn_id AS "turnId", thread_id AS "threadId", state, requested_at AS "requestedAt",
        started_at AS "startedAt", completed_at AS "completedAt",
        assistant_message_id AS "assistantMessageId",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId"
      FROM projection_turns
      WHERE thread_id = ${threadId} AND turn_id IS NOT NULL
      ORDER BY requested_at DESC, turn_id DESC
      LIMIT 1
    `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () => sql`
      SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
      FROM projection_state
    `,
  });

  const listThreadWatchRows = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: ProjectionThreadWatchDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT watcher_thread_id AS "watcherThreadId", watched_thread_id AS "watchedThreadId",
        watched_thread_title AS "watchedThreadTitle"
      FROM projection_thread_watches
      WHERE watcher_thread_id = ${threadId} AND status = 'active'
    `,
  });

  return {
    listProjectRows,
    listThreadRows,
    listThreadMessageRows,
    listAllThreadMessageRows,
    listThreadActivityRows,
    listAllThreadActivityRows,
    listThreadProposedPlanRows,
    listThreadTaskRows,
    listThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listProjectionStateRows,
    listThreadWatchRows,
  };
}

export type ThreadOperationalStateSql = ReturnType<typeof makeThreadOperationalStateSql>;
