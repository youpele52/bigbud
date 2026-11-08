import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { unresolvedAdmissionSql } from "./ProviderTurnAdmissions.activity.ts";
import type {
  ThreadRetentionAgeCriterion,
  ThreadRetentionSelectionMode,
} from "@bigbud/contracts/core/settings.threadRetention.ts";

/** Sidebar-visible recency: latest user message, else thread created_at. */
export function retentionVisibleActivitySql(threadAlias: string): string {
  return `COALESCE((
      SELECT MAX(message.created_at)
      FROM projection_thread_messages AS message
      WHERE message.thread_id = ${threadAlias}.thread_id AND message.role = 'user'
    ), ${threadAlias}.created_at)`;
}

export function retentionAgeSql(
  threadAlias: string,
  criterion: ThreadRetentionAgeCriterion,
): string {
  return criterion === "created"
    ? `${threadAlias}.created_at`
    : retentionVisibleActivitySql(threadAlias);
}

/** SQLite's own clock in the ISO format every lease and task timestamp uses. */
export const RETENTION_SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** Open tasks untouched this long, on a thread with no turn in progress, are leftovers. */
export const RETENTION_STALE_TASK_SQL_MODIFIER = "-24 hours";

/**
 * Real work on a thread, never a bound but idle provider session (the delete handler stops
 * that one): a turn in progress, a terminal or shell lease the heartbeat still renews, an
 * unexpired browser or computer-use lease, or a learning cleanup fence. A NULL `expires_at` is
 * a lease acquired in this process before its first heartbeat, so it counts as live.
 */
export function retentionRunningWorkSql(threadAlias: string): string {
  return `EXISTS (
        SELECT 1 FROM projection_thread_sessions AS session
        WHERE session.thread_id = ${threadAlias}.thread_id
          AND (session.status IN ('starting', 'running') OR session.active_turn_id IS NOT NULL)
      ) OR EXISTS (
        SELECT 1 FROM worktree_runtime_leases AS lease
        WHERE lease.thread_id = ${threadAlias}.thread_id
          AND lease.runtime_kind IN ('terminal', 'shell')
          AND (lease.expires_at IS NULL OR lease.expires_at > ${RETENTION_SQL_NOW})
      ) OR EXISTS (
        SELECT 1 FROM thread_activity_leases AS lease
        WHERE lease.thread_id = ${threadAlias}.thread_id
          AND (lease.activity_kind = 'learning' OR lease.expires_at IS NULL
            OR lease.expires_at > ${RETENTION_SQL_NOW})
      )`;
}

export function retentionExclusionCaseSql(
  threadAlias: string,
  mode: ThreadRetentionSelectionMode = "legacy-subtree",
): string {
  return `
    CASE
      WHEN ${threadAlias}.deleted_at IS NOT NULL THEN 'already_deleted'
      WHEN ${threadAlias}.deleting_at IS NOT NULL THEN 'deleting'
      WHEN ${threadAlias}.pinned_at IS NOT NULL THEN 'pinned'
      WHEN NOT EXISTS (
        SELECT 1 FROM projection_projects AS project
        WHERE project.project_id = ${threadAlias}.project_id AND project.deleted_at IS NULL
      ) THEN 'project_unavailable'
      WHEN EXISTS (
        SELECT 1 FROM projection_projects AS project
        WHERE project.project_id = ${threadAlias}.project_id AND project.deleting_at IS NOT NULL
      ) THEN 'project_deleting'
      ${
        mode === "legacy-subtree"
          ? `WHEN ${threadAlias}.provider_runtime_execution_target_id <> 'local'
        OR ${threadAlias}.workspace_execution_target_id <> 'local'
        OR ${threadAlias}.execution_target_id <> 'local' THEN 'remote_cleanup_unavailable'`
          : ""
      }
      WHEN ${retentionRunningWorkSql(threadAlias)} THEN 'running'
      WHEN EXISTS (${unresolvedAdmissionSql(`${threadAlias}.thread_id`)}) OR (json_valid(${threadAlias}.queued_prompts_json) AND json_array_length(${threadAlias}.queued_prompts_json) > 0) OR EXISTS (
        SELECT 1 FROM projection_turns AS turn
        WHERE turn.thread_id = ${threadAlias}.thread_id AND turn.state = 'pending'
      ) OR EXISTS (
        SELECT 1 FROM automation_runs AS run
        WHERE run.thread_id = ${threadAlias}.thread_id AND run.status = 'started'
      ) THEN 'pending_work'
      WHEN EXISTS (
        SELECT 1 FROM projection_pending_approvals AS approval
        WHERE approval.thread_id = ${threadAlias}.thread_id AND approval.status = 'pending'
      ) OR EXISTS (
        SELECT 1 FROM projection_pending_user_inputs AS user_input
        WHERE user_input.thread_id = ${threadAlias}.thread_id AND user_input.status = 'pending'
      ) OR (${threadAlias}.interaction_mode = 'plan' AND ${threadAlias}.has_actionable_proposed_plan = 1)
        THEN 'waiting_for_user'
      WHEN EXISTS (
        SELECT 1 FROM projection_thread_tasks AS task
        WHERE task.thread_id = ${threadAlias}.thread_id
          AND json_valid(task.task_json)
          AND json_extract(task.task_json, '$.status') IN ('pending', 'inProgress')
          AND task.updated_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${RETENTION_STALE_TASK_SQL_MODIFIER}')
      ) THEN 'active_task'
      WHEN EXISTS (
        SELECT 1 FROM automation_schedules AS schedule
        WHERE schedule.target_thread_id = ${threadAlias}.thread_id
          AND schedule.owns_target_thread = 1 AND schedule.deleted_at IS NULL
      ) THEN 'automation_owned'
      WHEN EXISTS (
        SELECT 1 FROM automation_schedules AS schedule
        WHERE schedule.target_thread_id = ${threadAlias}.thread_id
          AND schedule.deleted_at IS NULL AND schedule.paused_at IS NULL
          AND schedule.completed_at IS NULL AND schedule.next_run_at IS NOT NULL
      ) THEN 'scheduled'
      ELSE NULL
    END
  `;
}

export function retentionExclusionCase(sql: SqlClient.SqlClient) {
  return sql.unsafe(retentionExclusionCaseSql("t"));
}

export function retentionDurableExclusions(sql: SqlClient.SqlClient) {
  const reason = retentionExclusionCase(sql);
  return sql`${reason} IS NULL`;
}
