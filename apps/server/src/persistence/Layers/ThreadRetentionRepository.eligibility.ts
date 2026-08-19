import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Sidebar-visible recency: latest user message, else thread created_at. */
export function retentionVisibleActivitySql(threadAlias: string): string {
  return `COALESCE((
      SELECT MAX(message.created_at)
      FROM projection_thread_messages AS message
      WHERE message.thread_id = ${threadAlias}.thread_id AND message.role = 'user'
    ), ${threadAlias}.created_at)`;
}

export const retentionExclusionCaseSql = `
    CASE
      WHEN t.deleted_at IS NOT NULL THEN 'already_deleted'
      WHEN t.deleting_at IS NOT NULL THEN 'deleting'
      WHEN t.pinned_at IS NOT NULL THEN 'pinned'
      WHEN NOT EXISTS (
        SELECT 1 FROM projection_projects AS project
        WHERE project.project_id = t.project_id AND project.deleted_at IS NULL
      ) THEN 'project_unavailable'
      WHEN EXISTS (
        SELECT 1 FROM projection_projects AS project
        WHERE project.project_id = t.project_id AND project.deleting_at IS NOT NULL
      ) THEN 'project_deleting'
      WHEN t.provider_runtime_execution_target_id <> 'local'
        OR t.workspace_execution_target_id <> 'local'
        OR t.execution_target_id <> 'local' THEN 'remote_cleanup_unavailable'
      WHEN EXISTS (
        SELECT 1 FROM projection_thread_sessions AS session
        WHERE session.thread_id = t.thread_id AND session.status IN ('starting', 'running')
      ) OR EXISTS (
        SELECT 1 FROM provider_session_runtime AS runtime
        WHERE runtime.thread_id = t.thread_id AND runtime.status IN ('starting', 'running')
      ) OR EXISTS (
        SELECT 1 FROM worktree_runtime_leases AS lease
        WHERE lease.thread_id = t.thread_id
      ) OR EXISTS (
        SELECT 1 FROM thread_activity_leases AS lease
        WHERE lease.thread_id = t.thread_id
      ) THEN 'running'
      WHEN (json_valid(t.queued_prompts_json) AND json_array_length(t.queued_prompts_json) > 0) OR EXISTS (
        SELECT 1 FROM projection_turns AS turn
        WHERE turn.thread_id = t.thread_id AND turn.state = 'pending'
      ) OR EXISTS (
        SELECT 1 FROM automation_runs AS run
        WHERE run.thread_id = t.thread_id AND run.status = 'started'
      ) THEN 'pending_work'
      WHEN EXISTS (
        SELECT 1 FROM projection_pending_approvals AS approval
        WHERE approval.thread_id = t.thread_id AND approval.status = 'pending'
      ) OR EXISTS (
        SELECT 1 FROM projection_pending_user_inputs AS user_input
        WHERE user_input.thread_id = t.thread_id AND user_input.status = 'pending'
      ) OR (t.interaction_mode = 'plan' AND t.has_actionable_proposed_plan = 1)
        THEN 'waiting_for_user'
      WHEN EXISTS (
        SELECT 1 FROM projection_thread_tasks AS task
        WHERE task.thread_id = t.thread_id
          AND json_valid(task.task_json)
          AND json_extract(task.task_json, '$.status') IN ('pending', 'inProgress')
      ) THEN 'active_task'
      WHEN EXISTS (
        SELECT 1 FROM automation_schedules AS schedule
        WHERE schedule.target_thread_id = t.thread_id
          AND schedule.owns_target_thread = 1 AND schedule.deleted_at IS NULL
      ) THEN 'automation_owned'
      WHEN EXISTS (
        SELECT 1 FROM automation_schedules AS schedule
        WHERE schedule.target_thread_id = t.thread_id
          AND schedule.deleted_at IS NULL AND schedule.paused_at IS NULL
          AND schedule.completed_at IS NULL AND schedule.next_run_at IS NOT NULL
      ) THEN 'scheduled'
      ELSE NULL
    END
  `;

export function retentionExclusionCase(sql: SqlClient.SqlClient) {
  return sql.unsafe(retentionExclusionCaseSql);
}

export function retentionDurableExclusions(sql: SqlClient.SqlClient) {
  const reason = retentionExclusionCase(sql);
  return sql`${reason} IS NULL`;
}
