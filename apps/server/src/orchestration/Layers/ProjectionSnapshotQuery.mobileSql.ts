import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ThreadId } from "@bigbud/contracts";

import {
  ProjectionCheckpointDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionThreadTaskDbRowSchema,
  ProjectionThreadWatchDbRowSchema,
} from "./ProjectionSnapshotQuerySql.ts";
import { makeMobileHistoryQueries } from "./ProjectionSnapshotQuery.mobileSql.history.ts";

export const MobileRecoveryQueryInput = Schema.Struct({
  selectedThreadId: Schema.NullOr(ThreadId),
});
export type MobileRecoveryQueryInput = typeof MobileRecoveryQueryInput.Type;

function makeEligibleThreadsCte(sql: SqlClient.SqlClient, selectedThreadId: string | null) {
  return sql`
    WITH active_threads AS (
      SELECT thread_id
      FROM projection_threads
      WHERE archived_at IS NULL AND deleted_at IS NULL
    ), selected_thread AS (
      SELECT thread_id
      FROM projection_threads
      WHERE thread_id = ${selectedThreadId} AND deleted_at IS NULL
    ), eligible_threads AS (
      SELECT thread_id FROM active_threads
      UNION
      SELECT thread_id FROM selected_thread
    )
  `;
}

export function makeMobileProjectionSnapshotQuerySql(sql: SqlClient.SqlClient) {
  const { listActivityRows, listMessageRows } = makeMobileHistoryQueries(sql);
  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          purpose,
          COALESCE(elevator_summary, title) AS "elevatorSummary",
          elevator_summary_message_count AS "elevatorSummaryMessageCount",
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          queued_prompts_json AS "queuedPrompts",
          pending_interrupt_flush_intent_json AS "pendingInterruptFlushIntent",
          pending_turn_control_operation_json AS "pendingTurnControlOperation",
          queue_hold AS "queueHold",
          CASE
            WHEN parent_thread_id IS NULL OR parent_thread_title IS NULL THEN NULL
            ELSE json_object(
              'threadId', parent_thread_id,
              'title', parent_thread_title,
              'projectId', COALESCE(parent_thread_project_id, project_id)
            )
          END AS "parentThread",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_activity_at AS "lastActivityAt",
          archived_at AS "archivedAt",
          pinned_at AS "pinnedAt",
          deleting_at AS "deletingAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE archived_at IS NULL AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const getSelectedThreadRow = SqlSchema.findOneOption({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          purpose,
          COALESCE(elevator_summary, title) AS "elevatorSummary",
          elevator_summary_message_count AS "elevatorSummaryMessageCount",
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          queued_prompts_json AS "queuedPrompts",
          pending_interrupt_flush_intent_json AS "pendingInterruptFlushIntent",
          pending_turn_control_operation_json AS "pendingTurnControlOperation",
          queue_hold AS "queueHold",
          CASE
            WHEN parent_thread_id IS NULL OR parent_thread_title IS NULL THEN NULL
            ELSE json_object(
              'threadId', parent_thread_id,
              'title', parent_thread_title,
              'projectId', COALESCE(parent_thread_project_id, project_id)
            )
          END AS "parentThread",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_activity_at AS "lastActivityAt",
          archived_at AS "archivedAt",
          pinned_at AS "pinnedAt",
          deleting_at AS "deletingAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${selectedThreadId}
        LIMIT 1
      `,
  });

  const listProposedPlanRows = SqlSchema.findAll({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        ${makeEligibleThreadsCte(sql, selectedThreadId)}
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id IN (SELECT thread_id FROM eligible_threads)
          AND (
            thread_id = ${selectedThreadId}
            OR turn_id = (
              SELECT latest_turn_id FROM projection_threads
              WHERE projection_threads.thread_id = projection_thread_proposed_plans.thread_id
            )
          )
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listTaskRows = SqlSchema.findAll({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionThreadTaskDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        ${makeEligibleThreadsCte(sql, selectedThreadId)}
        SELECT
          task_id AS "taskId",
          thread_id AS "threadId",
          task_json AS "task",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_tasks
        WHERE thread_id IN (SELECT thread_id FROM eligible_threads)
        ORDER BY thread_id ASC, created_at ASC, task_id ASC
      `,
  });

  const listSessionRows = SqlSchema.findAll({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        ${makeEligibleThreadsCte(sql, selectedThreadId)}
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          session_epoch AS "sessionEpoch",
          reason,
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id IN (SELECT thread_id FROM eligible_threads)
        ORDER BY thread_id ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        ${makeEligibleThreadsCte(sql, selectedThreadId)}
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns AS turns
        INNER JOIN eligible_threads
          ON eligible_threads.thread_id = turns.thread_id
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = turns.thread_id
         AND threads.latest_turn_id = turns.turn_id
        WHERE turns.turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listSelectedCheckpointRows = SqlSchema.findAll({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${selectedThreadId}
          AND EXISTS (
            SELECT 1
            FROM projection_threads
            WHERE thread_id = ${selectedThreadId} AND deleted_at IS NULL
          )
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const listSelectedWatchRows = SqlSchema.findAll({
    Request: MobileRecoveryQueryInput,
    Result: ProjectionThreadWatchDbRowSchema,
    execute: ({ selectedThreadId }) =>
      sql`
        SELECT
          watcher_thread_id AS "watcherThreadId",
          watched_thread_id AS "watchedThreadId",
          watched_thread_title AS "watchedThreadTitle"
        FROM projection_thread_watches
        WHERE watcher_thread_id = ${selectedThreadId}
          AND status = 'active'
        ORDER BY watched_thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        ORDER BY projector ASC
      `,
  });

  return {
    getSelectedThreadRow,
    listActiveThreadRows,
    listActivityRows,
    listLatestTurnRows,
    listMessageRows,
    listProjectionStateRows,
    listProposedPlanRows,
    listSelectedCheckpointRows,
    listSelectedWatchRows,
    listSessionRows,
    listTaskRows,
  };
}

export type MobileProjectionSnapshotQuerySql = ReturnType<
  typeof makeMobileProjectionSnapshotQuerySql
>;
