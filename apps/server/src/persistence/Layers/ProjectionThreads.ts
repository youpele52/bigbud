import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  OrchestrationQueuedPrompt,
  OrchestrationPendingInterruptFlushIntent,
  OrchestrationTurnControlOperation,
  ParentThreadReference,
  PersistedModelSelection,
} from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import { captureWorktreePathIdentity } from "../../retention/worktreeRuntimeLease.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  TouchProjectionThreadActivityInput,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    // Keep historical provider selections readable after a provider is removed.
    modelSelection: Schema.fromJsonString(PersistedModelSelection),
    parentThread: Schema.NullOr(Schema.fromJsonString(ParentThreadReference)),
    queuedPrompts: Schema.fromJsonString(Schema.Array(OrchestrationQueuedPrompt)),
    pendingInterruptFlushIntent: Schema.NullOr(
      Schema.fromJsonString(OrchestrationPendingInterruptFlushIntent),
    ),
    pendingTurnControlOperation: Schema.NullOr(
      Schema.fromJsonString(OrchestrationTurnControlOperation),
    ),
    queueHold: Schema.Number,
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const ProjectionThreadWriteRow = ProjectionThread.mapFields(
  Struct.assign({
    worktreeIdentity: Schema.NullOr(
      Schema.Struct({
        canonicalPath: Schema.String,
        device: Schema.Number,
        inode: Schema.Number,
      }),
    ),
  }),
);

function normalizeProjectionThreadRow(row: ProjectionThreadDbRow): typeof ProjectionThread.Type {
  return {
    threadId: row.threadId,
    projectId: row.projectId,
    title: row.title,
    purpose: row.purpose,
    elevatorSummary: row.elevatorSummary,
    elevatorSummaryMessageCount: row.elevatorSummaryMessageCount,
    providerRuntimeExecutionTargetId: row.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: row.workspaceExecutionTargetId,
    executionTargetId: row.executionTargetId,
    modelSelection: row.modelSelection as ProjectionThread["modelSelection"],
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    branch: row.branch,
    worktreePath: row.worktreePath,
    ...(row.parentThread !== null ? { parentThread: row.parentThread } : {}),
    latestTurnId: row.latestTurnId,
    queuedPrompts: row.queuedPrompts,
    ...(row.pendingInterruptFlushIntent !== undefined
      ? { pendingInterruptFlushIntent: row.pendingInterruptFlushIntent }
      : {}),
    pendingTurnControlOperation: row.pendingTurnControlOperation ?? null,
    queueHold: row.queueHold === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    archivedAt: row.archivedAt,
    pinnedAt: row.pinnedAt,
    deletingAt: row.deletingAt,
    deletedAt: row.deletedAt,
  };
}

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThreadWriteRow,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          purpose,
          elevator_summary,
          elevator_summary_message_count,
          provider_runtime_execution_target_id,
          workspace_execution_target_id,
          execution_target_id,
          model_selection_json,
          runtime_mode,
           interaction_mode,
           branch,
           worktree_path,
           worktree_canonical_path,
           worktree_device,
           worktree_inode,
           parent_thread_id,
           parent_thread_title,
           parent_thread_project_id,
          latest_turn_id,
           queued_prompts_json,
           pending_interrupt_flush_intent_json,
           pending_turn_control_operation_json,
           queue_hold,
          created_at,
          updated_at,
          last_activity_at,
          archived_at,
          pinned_at,
          deleting_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${row.purpose},
          ${row.elevatorSummary},
          ${row.elevatorSummaryMessageCount},
          ${row.providerRuntimeExecutionTargetId},
          ${row.workspaceExecutionTargetId},
          ${row.executionTargetId},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
           ${row.interactionMode},
           ${row.branch},
           ${row.worktreePath},
           ${row.worktreeIdentity?.canonicalPath ?? null},
           ${row.worktreeIdentity?.device ?? null},
           ${row.worktreeIdentity?.inode ?? null},
           ${row.parentThread?.threadId ?? null},
           ${row.parentThread?.title ?? null},
           ${row.parentThread?.projectId ?? row.projectId},
          ${row.latestTurnId},
           ${JSON.stringify(row.queuedPrompts)},
           ${row.pendingInterruptFlushIntent == null ? null : JSON.stringify(row.pendingInterruptFlushIntent)},
           ${row.pendingTurnControlOperation == null ? null : JSON.stringify(row.pendingTurnControlOperation)},
           ${row.queueHold ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.lastActivityAt},
          ${row.archivedAt},
          ${row.pinnedAt},
          ${row.deletingAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          purpose = excluded.purpose,
          elevator_summary = excluded.elevator_summary,
          elevator_summary_message_count = excluded.elevator_summary_message_count,
          provider_runtime_execution_target_id = excluded.provider_runtime_execution_target_id,
          workspace_execution_target_id = excluded.workspace_execution_target_id,
          execution_target_id = excluded.execution_target_id,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
           branch = excluded.branch,
           worktree_path = excluded.worktree_path,
           worktree_canonical_path = excluded.worktree_canonical_path,
           worktree_device = excluded.worktree_device,
           worktree_inode = excluded.worktree_inode,
           parent_thread_id = excluded.parent_thread_id,
           parent_thread_title = excluded.parent_thread_title,
           parent_thread_project_id = excluded.parent_thread_project_id,
          latest_turn_id = excluded.latest_turn_id,
           queued_prompts_json = excluded.queued_prompts_json,
           pending_interrupt_flush_intent_json = excluded.pending_interrupt_flush_intent_json,
           pending_turn_control_operation_json = excluded.pending_turn_control_operation_json,
           queue_hold = excluded.queue_hold,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_activity_at = MAX(projection_threads.last_activity_at, excluded.last_activity_at),
          archived_at = excluded.archived_at,
          pinned_at = excluded.pinned_at,
          deleting_at = excluded.deleting_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
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
          CASE
             WHEN parent_thread_id IS NULL OR parent_thread_title IS NULL THEN NULL
             ELSE json_object(
               'threadId', parent_thread_id,
               'title', parent_thread_title,
               'projectId', COALESCE(parent_thread_project_id, project_id)
             )
          END AS "parentThread",
          latest_turn_id AS "latestTurnId",
           queued_prompts_json AS "queuedPrompts",
           pending_interrupt_flush_intent_json AS "pendingInterruptFlushIntent",
           pending_turn_control_operation_json AS "pendingTurnControlOperation",
           queue_hold AS "queueHold",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_activity_at AS "lastActivityAt",
          archived_at AS "archivedAt",
          pinned_at AS "pinnedAt",
          deleting_at AS "deletingAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
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
          CASE
             WHEN parent_thread_id IS NULL OR parent_thread_title IS NULL THEN NULL
             ELSE json_object(
               'threadId', parent_thread_id,
               'title', parent_thread_title,
               'projectId', COALESCE(parent_thread_project_id, project_id)
             )
          END AS "parentThread",
          latest_turn_id AS "latestTurnId",
           queued_prompts_json AS "queuedPrompts",
           pending_interrupt_flush_intent_json AS "pendingInterruptFlushIntent",
           pending_turn_control_operation_json AS "pendingTurnControlOperation",
           queue_hold AS "queueHold",
           created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_activity_at AS "lastActivityAt",
          archived_at AS "archivedAt",
          pinned_at AS "pinnedAt",
          deleting_at AS "deletingAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE projection_threads
            SET parent_thread_id = NULL,
              parent_thread_title = NULL,
              parent_thread_project_id = NULL
            WHERE parent_thread_id = ${threadId}
          `;
          yield* sql`
            DELETE FROM projection_threads
            WHERE thread_id = ${threadId}
          `;
        }),
      ),
  });

  const touchProjectionThreadActivity = SqlSchema.void({
    Request: TouchProjectionThreadActivityInput,
    execute: ({ threadId, occurredAt }) => sql`
      UPDATE projection_threads
      SET last_activity_at = MAX(last_activity_at, ${occurredAt})
      WHERE thread_id = ${threadId}
        AND deleted_at IS NULL
    `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    Effect.gen(function* () {
      const worktreeIdentity = yield* Effect.tryPromise({
        try: () =>
          row.worktreePath === null
            ? Promise.resolve(null)
            : captureWorktreePathIdentity(row.worktreePath),
        catch: () => null,
      });
      yield* upsertProjectionThreadRow({ ...row, worktreeIdentity });
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")));

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.map(Option.map(normalizeProjectionThreadRow)),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.map((rows) => rows.map(normalizeProjectionThreadRow)),
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  const touchActivity: ProjectionThreadRepositoryShape["touchActivity"] = (input) =>
    touchProjectionThreadActivity(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.touchActivity:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
    touchActivity,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
