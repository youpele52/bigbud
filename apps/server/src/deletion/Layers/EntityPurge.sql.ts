import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const ThreadInput = Schema.Struct({ threadId: ThreadId });
const ProjectInput = Schema.Struct({ projectId: ProjectId });
const ThreadIdRow = Schema.Struct({ threadId: ThreadId });
const DeletedThreadRow = Schema.Struct({ threadId: ThreadId });
const DeletedProjectRow = Schema.Struct({ projectId: ProjectId });
const ThreadAssetRow = Schema.Struct({
  attachmentsJson: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
});
const RemainingRow = Schema.Struct({ count: Schema.Number });
const DeletionMarkerRow = Schema.Struct({ deletionSequence: Schema.Number });
type DeletionMarkerRow = typeof DeletionMarkerRow.Type;

export function makeEntityPurgeSql(sql: SqlClient.SqlClient) {
  const readThreadAssets = SqlSchema.findAll({
    Request: ThreadInput,
    Result: ThreadAssetRow,
    execute: ({ threadId }) => sql`
      SELECT messages.attachments_json AS "attachmentsJson", threads.worktree_path AS "worktreePath"
      FROM projection_threads AS threads
      LEFT JOIN projection_thread_messages AS messages ON messages.thread_id = threads.thread_id
      WHERE threads.thread_id = ${threadId}
    `,
  });

  const listProjectThreadIds = SqlSchema.findAll({
    Request: ProjectInput,
    Result: ThreadIdRow,
    execute: ({ projectId }) => sql`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      WHERE project_id = ${projectId}
      ORDER BY thread_id ASC
    `,
  });

  const listDeletedThreads = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Number }),
    Result: DeletedThreadRow,
    execute: ({ limit }) => sql`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at ASC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  const listDeletedProjects = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Number }),
    Result: DeletedProjectRow,
    execute: ({ limit }) => sql`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at ASC, project_id ASC
      LIMIT ${limit}
    `,
  });

  const countThreadRows = SqlSchema.findOne({
    Request: ThreadInput,
    Result: RemainingRow,
    execute: ({ threadId }) => sql`
      SELECT (
        (SELECT COUNT(*) FROM projection_thread_messages WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_activities WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_tasks WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_pending_user_inputs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_usage_contributions WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_watches
          WHERE watcher_thread_id = ${threadId} OR watched_thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM thread_delegations
          WHERE caller_thread_id = ${threadId} OR child_thread_id = ${threadId})
      ) AS count
    `,
  });

  const countProjectRows = SqlSchema.findOne({
    Request: ProjectInput,
    Result: RemainingRow,
    execute: ({ projectId }) => sql`
      SELECT (
        (SELECT COUNT(*) FROM projection_threads WHERE project_id = ${projectId}) +
        (SELECT COUNT(*) FROM projection_notes WHERE project_id = ${projectId}) +
        (SELECT COUNT(*) FROM automation_schedules WHERE project_id = ${projectId}) +
        (SELECT COUNT(*) FROM thread_delegations
          WHERE target_project_id = ${projectId} OR created_project_id = ${projectId})
      ) AS count
    `,
  });

  const deleteThreadDependents = ({ threadId }: { readonly threadId: ThreadId }) =>
    sql.withTransaction(
      Effect.all(
        [
          sql`DELETE FROM automation_runs WHERE thread_id = ${threadId}`,
          sql`DELETE FROM automation_schedules WHERE target_thread_id = ${threadId}`,
          sql`DELETE FROM projection_thread_watches WHERE watcher_thread_id = ${threadId} OR watched_thread_id = ${threadId}`,
          sql`DELETE FROM thread_delegations WHERE caller_thread_id = ${threadId} OR child_thread_id = ${threadId}`,
          sql`DELETE FROM learning_jobs WHERE thread_id = ${threadId}`,
          sql`DELETE FROM skill_change_proposals WHERE thread_id = ${threadId}`,
          sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_usage_contributions WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_pending_user_inputs WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`,
          sql`DELETE FROM provider_session_runtime WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_thread_tasks WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`,
          sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`,
        ],
        { concurrency: 1, discard: true },
      ),
    );

  const deleteProjectDependents = ({ projectId }: { readonly projectId: ProjectId }) =>
    sql.withTransaction(
      Effect.all(
        [
          sql`DELETE FROM automation_runs WHERE automation_id IN (SELECT automation_id FROM automation_schedules WHERE project_id = ${projectId})`,
          sql`DELETE FROM automation_schedules WHERE project_id = ${projectId}`,
          sql`DELETE FROM projection_notes WHERE project_id = ${projectId}`,
          sql`DELETE FROM thread_delegations WHERE target_project_id = ${projectId} OR created_project_id = ${projectId}`,
        ],
        { concurrency: 1, discard: true },
      ),
    );

  const deleteOrphanRows = (limit: number) =>
    sql.withTransaction(
      Effect.all(
        [
          sql`DELETE FROM projection_thread_messages WHERE rowid IN (SELECT rowid FROM projection_thread_messages WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_messages.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_thread_activities WHERE rowid IN (SELECT rowid FROM projection_thread_activities WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_activities.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_thread_proposed_plans WHERE rowid IN (SELECT rowid FROM projection_thread_proposed_plans WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_proposed_plans.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_thread_tasks WHERE rowid IN (SELECT rowid FROM projection_thread_tasks WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_tasks.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_thread_sessions WHERE rowid IN (SELECT rowid FROM projection_thread_sessions WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_thread_sessions.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_turns WHERE rowid IN (SELECT rowid FROM projection_turns WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_turns.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_pending_approvals WHERE rowid IN (SELECT rowid FROM projection_pending_approvals WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_pending_approvals.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_pending_user_inputs WHERE rowid IN (SELECT rowid FROM projection_pending_user_inputs WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_pending_user_inputs.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_usage_contributions WHERE rowid IN (SELECT rowid FROM projection_usage_contributions WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = projection_usage_contributions.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM provider_session_runtime WHERE rowid IN (SELECT rowid FROM provider_session_runtime WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = provider_session_runtime.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM checkpoint_diff_blobs WHERE rowid IN (SELECT rowid FROM checkpoint_diff_blobs WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = checkpoint_diff_blobs.thread_id) LIMIT ${limit})`,
          sql`DELETE FROM projection_notes WHERE rowid IN (SELECT rowid FROM projection_notes WHERE project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projection_projects WHERE projection_projects.project_id = projection_notes.project_id) LIMIT ${limit})`,
        ],
        { concurrency: 1, discard: true },
      ),
    );

  const readCanonicalProof = (input: {
    readonly entityKind: "project" | "thread";
    readonly entityId: ProjectId | ThreadId;
  }) =>
    sql<{
      readonly canonicalCount: number;
      readonly coveredByBaselineSequence: number | null;
      readonly deletionSequence: number | null;
      readonly maxCanonicalSequence: number;
    }>`
      SELECT
        ((SELECT COUNT(*) FROM orchestration_events
          WHERE aggregate_kind = ${input.entityKind} AND stream_id = ${input.entityId}) +
         (SELECT COUNT(*) FROM orchestration_command_receipts
          WHERE aggregate_kind = ${input.entityKind} AND aggregate_id = ${input.entityId}))
          AS "canonicalCount",
        (SELECT marker.covered_by_baseline_sequence
          FROM orchestration_deletion_markers AS marker
          JOIN projection_baselines AS baseline
            ON baseline.sequence = marker.covered_by_baseline_sequence
           AND baseline.verification_status = 'verified'
          WHERE marker.entity_kind = ${input.entityKind} AND marker.entity_id = ${input.entityId})
          AS "coveredByBaselineSequence",
        (SELECT deletion_sequence FROM orchestration_deletion_markers
          WHERE entity_kind = ${input.entityKind} AND entity_id = ${input.entityId})
          AS "deletionSequence",
        MAX(
          COALESCE((SELECT MAX(sequence) FROM orchestration_events
            WHERE aggregate_kind = ${input.entityKind} AND stream_id = ${input.entityId}), 0),
          COALESCE((SELECT MAX(result_sequence) FROM orchestration_command_receipts
            WHERE aggregate_kind = ${input.entityKind} AND aggregate_id = ${input.entityId}), 0)
        ) AS "maxCanonicalSequence"
    `;

  const readDeletionMarker = (input: {
    readonly entityKind: "project" | "thread";
    readonly entityId: ProjectId | ThreadId;
  }) =>
    sql<DeletionMarkerRow>`
      SELECT deletion_sequence AS "deletionSequence"
      FROM orchestration_deletion_markers
      WHERE entity_kind = ${input.entityKind} AND entity_id = ${input.entityId}
      LIMIT 1
    `;

  const deleteProvenReceipts = (input: {
    readonly entityKind: "project" | "thread";
    readonly entityId: ProjectId | ThreadId;
  }) =>
    sql`
      DELETE FROM orchestration_command_receipts
      WHERE aggregate_kind = ${input.entityKind} AND aggregate_id = ${input.entityId}
        AND EXISTS (
          SELECT 1 FROM orchestration_deletion_markers AS marker
          JOIN projection_baselines AS baseline
            ON baseline.sequence = marker.covered_by_baseline_sequence
           AND baseline.verification_status = 'verified'
          WHERE marker.entity_kind = ${input.entityKind} AND marker.entity_id = ${input.entityId}
            AND orchestration_command_receipts.result_sequence <= marker.covered_by_baseline_sequence
        )
    `.pipe(Effect.asVoid);

  return {
    readThreadAssets,
    listProjectThreadIds,
    listDeletedThreads,
    listDeletedProjects,
    deleteThreadDependents,
    deleteProjectDependents,
    deleteOrphanRows,
    countThreadRows,
    countProjectRows,
    readCanonicalProof,
    readDeletionMarker,
    deleteProvenReceipts,
    deleteThreadRoot: ({ threadId }: { readonly threadId: ThreadId }) =>
      sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`.pipe(Effect.asVoid),
    deleteProjectRoot: ({ projectId }: { readonly projectId: ProjectId }) =>
      sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`.pipe(Effect.asVoid),
  };
}
