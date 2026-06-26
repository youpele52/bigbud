/**
 * SQL query definitions for the ProjectionSnapshotQuery layer.
 *
 * All SqlSchema-based query builders are defined here and consumed by
 * ProjectionSnapshotQueryAssembly to build the full read model.
 */
import { Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export {
  ProjectionCheckpointDbRowSchema,
  ProjectionCountsRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionProjectDbRowSchema,
  ProjectionProjectLookupRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadCheckpointContextThreadRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadIdLookupRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectIdLookupInput,
  ThreadIdLookupInput,
  WorkspaceRootLookupInput,
  ProjectionThreadWatchDbRowSchema,
} from "./ProjectionSnapshotQuerySql.schemas.ts";
import {
  ProjectionCheckpointDbRowSchema,
  ProjectionCountsRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectionProjectDbRowSchema,
  ProjectionProjectLookupRowSchema,
  ProjectionStateDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadCheckpointContextThreadRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadIdLookupRowSchema,
  ProjectionThreadMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionThreadWatchDbRowSchema,
  ProjectIdLookupInput,
  ThreadIdLookupInput,
  WorkspaceRootLookupInput,
} from "./ProjectionSnapshotQuerySql.schemas.ts";

// ---------------------------------------------------------------------------
// Query factories (require a SqlClient instance)
// ---------------------------------------------------------------------------

export function makeProjectionSnapshotQuerySql(sql: SqlClient.SqlClient) {
  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleting_at AS "deletingAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          CASE
            WHEN parent_thread_id IS NULL OR parent_thread_title IS NULL THEN NULL
            ELSE json_object('threadId', parent_thread_id, 'title', parent_thread_title)
          END AS "parentThread",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleting_at AS "deletingAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          reply_to_json AS "replyTo",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
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
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          reason,
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
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
        WHERE checkpoint_turn_count IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
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
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
          workspace_execution_target_id AS "workspaceExecutionTargetId",
          execution_target_id AS "executionTargetId",
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          threads.execution_target_id AS "executionTargetId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listThreadWatchRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadWatchDbRowSchema,
    execute: () =>
      sql`
        SELECT
          watcher_thread_id AS "watcherThreadId",
          watched_thread_id AS "watchedThreadId",
          watched_thread_title AS "watchedThreadTitle"
        FROM projection_thread_watches
        WHERE status = 'active'
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
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
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  return {
    listProjectRows,
    listThreadRows,
    listThreadMessageRows,
    listThreadProposedPlanRows,
    listThreadActivityRows,
    listThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listProjectionStateRows,
    readProjectionCounts,
    getActiveProjectRowByWorkspaceRoot,
    getFirstActiveThreadIdByProject,
    getThreadCheckpointContextThreadRow,
    listCheckpointRowsByThread,
    listThreadWatchRows,
  };
}

export type ProjectionSnapshotQuerySql = ReturnType<typeof makeProjectionSnapshotQuerySql>;
