import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { threadOrganizationJsonSqlText } from "../../persistence/Layers/ProjectionThreads.organization.ts";

/**
 * The `ThreadSummary` columns shared by every catalog query. Requires the aliases
 * `t` (`projection_threads`), `s` (`projection_thread_sessions`, LEFT JOIN), and `turn`
 * (`projection_turns` for the latest turn, LEFT JOIN). Decode rows with `ThreadSummaryDbRow`.
 */
const THREAD_SUMMARY_COLUMNS_SQL = `
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
  ${threadOrganizationJsonSqlText("t")} AS "organization",
  s.status AS "sessionStatus",
  s.provider_name AS "providerName",
  s.active_turn_id AS "activeTurnId",
  s.retained_family AS "retainedFamily",
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
  ) AS "isAwaitingApproval",
  EXISTS (
    SELECT 1 FROM projection_pending_user_inputs u
    WHERE u.thread_id = t.thread_id AND u.status = 'pending'
  ) AS "isAwaitingUserInput"
`;

export function threadSummaryColumnsSql(sql: SqlClient.SqlClient) {
  return sql.unsafe(THREAD_SUMMARY_COLUMNS_SQL);
}

/** The joins `threadSummaryColumnsSql` needs after `FROM projection_threads t`. */
export function threadSummaryJoinsSql(sql: SqlClient.SqlClient) {
  return sql.unsafe(`
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    LEFT JOIN projection_turns turn
      ON turn.thread_id = t.thread_id AND turn.turn_id = t.latest_turn_id
  `);
}
