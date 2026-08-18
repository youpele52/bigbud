import { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { makeEntityPurgeCheckpointSql } from "./EntityPurge.sql.checkpoints.ts";

const ThreadInput = Schema.Struct({ threadId: ThreadId });
const ThreadAttachmentInput = Schema.Struct({ threadId: ThreadId, attachmentId: Schema.String });
const ProjectInput = Schema.Struct({ projectId: ProjectId });
const ThreadIdRow = Schema.Struct({ threadId: ThreadId });
const DeletionCandidateRow = Schema.Struct({
  entityKind: Schema.Literals(["thread", "project"]),
  entityId: Schema.String,
});
const ThreadAssetRow = Schema.Struct({
  activityKind: Schema.NullOr(Schema.String),
  activityPayloadJson: Schema.NullOr(Schema.String),
  attachmentsJson: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  workspaceRoot: Schema.NullOr(Schema.String),
});
const ThreadWorktreeRow = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.String,
});
const ThreadIdentityRow = Schema.Struct({ threadId: Schema.String });
const PurgeManifestRow = Schema.Struct({
  entityId: Schema.String,
  jobId: Schema.String,
  resourceManifestJson: Schema.String,
});
const LiveWorktreeIdentityRow = Schema.Struct({
  canonicalPath: Schema.String,
  device: Schema.Number,
  inode: Schema.Number,
});
const RemainingRow = Schema.Struct({ count: Schema.Number });
const DeletionMarkerRow = Schema.Struct({ deletionSequence: Schema.Number });
type DeletionMarkerRow = typeof DeletionMarkerRow.Type;

export function makeEntityPurgeSql(sql: SqlClient.SqlClient) {
  const checkpointQueries = makeEntityPurgeCheckpointSql(sql);
  const readThreadAssets = SqlSchema.findAll({
    Request: ThreadInput,
    Result: ThreadAssetRow,
    execute: ({ threadId }) => sql`
      SELECT
        NULL AS "activityKind",
        NULL AS "activityPayloadJson",
        messages.attachments_json AS "attachmentsJson",
        threads.worktree_path AS "worktreePath",
        projects.workspace_root AS "workspaceRoot"
      FROM projection_threads AS threads
      LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      LEFT JOIN projection_thread_messages AS messages ON messages.thread_id = threads.thread_id
      WHERE threads.thread_id = ${threadId}
      UNION ALL
      SELECT NULL, NULL, messages.attachments_json, NULL, NULL
      FROM projection_thread_messages AS messages
      WHERE messages.thread_id = ${threadId} AND messages.attachments_json IS NOT NULL
      UNION ALL
      SELECT activities.kind, activities.payload_json, NULL, NULL, NULL
      FROM projection_thread_activities AS activities
      WHERE activities.thread_id = ${threadId}
    `,
  });

  const attachmentIsShared = SqlSchema.findOne({
    Request: ThreadAttachmentInput,
    Result: Schema.Struct({ shared: Schema.Number }),
    execute: ({ threadId, attachmentId }) => sql`
      SELECT EXISTS (
        SELECT 1
        FROM projection_thread_attachment_refs
        WHERE thread_id <> ${threadId}
          AND attachment_id IN (${attachmentId}, '')
      ) AS shared
    `,
  });

  const listOtherThreadWorktrees = SqlSchema.findAll({
    Request: ThreadInput,
    Result: ThreadWorktreeRow,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", worktree_path AS "worktreePath"
      FROM projection_threads
      WHERE thread_id <> ${threadId} AND worktree_path IS NOT NULL
    `,
  });

  const listKnownThreadIds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadIdentityRow,
    execute: () => sql`
      SELECT thread_id AS "threadId" FROM projection_threads
      UNION SELECT thread_id FROM orchestration_thread_identity
      UNION SELECT entity_id FROM orchestration_deletion_markers WHERE entity_kind = 'thread'
    `,
  });

  const listIncompleteThreadManifests = SqlSchema.findAll({
    Request: ThreadInput,
    Result: PurgeManifestRow,
    execute: ({ threadId }) => sql`
      SELECT job_id AS "jobId", entity_id AS "entityId",
        resource_manifest_json AS "resourceManifestJson"
      FROM purge_jobs
      WHERE entity_kind = 'thread' AND entity_id <> ${threadId} AND status <> 'completed'
    `,
  });

  const listLiveWorktreeIdentities = SqlSchema.findAll({
    Request: ThreadInput,
    Result: LiveWorktreeIdentityRow,
    execute: () => sql`
      SELECT canonical_path AS "canonicalPath", device, inode
      FROM worktree_runtime_leases
    `,
  });

  const countThreadRuntimes = SqlSchema.findOne({
    Request: ThreadInput,
    Result: RemainingRow,
    execute: ({ threadId }) => sql`
      SELECT (
        (SELECT COUNT(*) FROM thread_activity_leases WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM worktree_runtime_leases WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM provider_session_runtime
          WHERE thread_id = ${threadId} AND status IN ('starting', 'running'))
      ) AS count
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

  const listDeletionCandidates = SqlSchema.findAll({
    Request: Schema.Struct({ limit: Schema.Number }),
    Result: DeletionCandidateRow,
    execute: ({ limit }) => sql`
      SELECT entity_kind AS "entityKind", entity_id AS "entityId"
      FROM (
        SELECT 'thread' AS entity_kind, thread_id AS entity_id, deleted_at AS ordered_at
        FROM projection_threads WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT 'project', project_id, deleted_at
        FROM projection_projects WHERE deleted_at IS NOT NULL
        UNION ALL
        SELECT entity_kind, entity_id, deleted_at
        FROM orchestration_deletion_markers
      ) AS candidates
      WHERE NOT EXISTS (
        SELECT 1 FROM purge_jobs AS job
        WHERE job.entity_kind = candidates.entity_kind
          AND job.entity_id = candidates.entity_id
      )
      GROUP BY entity_kind, entity_id
      ORDER BY MIN(ordered_at) ASC, entity_kind ASC, entity_id ASC
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
         (SELECT COUNT(*) FROM projection_thread_attachment_refs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_tasks WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_sessions WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_turns WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_pending_approvals WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_pending_user_inputs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_usage_contributions WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM worktree_runtime_leases WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM thread_activity_leases WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM automation_runs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM automation_schedules WHERE target_thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM learning_jobs WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM skill_change_proposals WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM orchestration_thread_identity WHERE thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_thread_watches
          WHERE watcher_thread_id = ${threadId} OR watched_thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM thread_delegations
          WHERE caller_thread_id = ${threadId} OR child_thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_threads WHERE parent_thread_id = ${threadId}) +
        (SELECT COUNT(*) FROM projection_turns WHERE source_proposed_plan_thread_id = ${threadId})
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
    Effect.uninterruptible(
      sql.withTransaction(
        Effect.gen(function* () {
          const beforeDeletion = yield* countThreadRuntimes({ threadId });
          if (beforeDeletion.count > 0) {
            return yield* Effect.fail(new Error("thread has an active durable activity lease"));
          }
          yield* Effect.all(
            [
              sql`DELETE FROM automation_runs WHERE thread_id = ${threadId}`,
              sql`DELETE FROM automation_schedules WHERE target_thread_id = ${threadId}`,
              sql`DELETE FROM projection_thread_watches WHERE watcher_thread_id = ${threadId} OR watched_thread_id = ${threadId}`,
              sql`DELETE FROM thread_delegations WHERE caller_thread_id = ${threadId} OR child_thread_id = ${threadId}`,
              sql`UPDATE projection_threads
                SET parent_thread_id = NULL, parent_thread_title = NULL, parent_thread_project_id = NULL
                WHERE parent_thread_id = ${threadId}`,
              sql`UPDATE projection_turns SET source_proposed_plan_thread_id = NULL, source_proposed_plan_id = NULL WHERE source_proposed_plan_thread_id = ${threadId}`,
              sql`DELETE FROM learning_jobs WHERE thread_id = ${threadId}`,
              sql`DELETE FROM skill_change_proposals WHERE thread_id = ${threadId}`,
              sql`DELETE FROM checkpoint_diff_blobs WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_usage_contributions WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_pending_approvals WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_pending_user_inputs WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_turns WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`,
              sql`DELETE FROM provider_session_runtime
            WHERE thread_id = ${threadId} AND status NOT IN ('starting', 'running')`,
              sql`DELETE FROM projection_thread_tasks WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_thread_proposed_plans WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`,
              sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`,
              sql`DELETE FROM orchestration_thread_identity WHERE thread_id = ${threadId}`,
            ],
            { concurrency: 1, discard: true },
          );
          const beforeFiles = yield* countThreadRuntimes({ threadId });
          if (beforeFiles.count > 0) {
            return yield* Effect.fail(new Error("thread has an active durable activity lease"));
          }
        }),
      ),
    );

  const deleteProjectDependents = ({ projectId }: { readonly projectId: ProjectId }) =>
    Effect.uninterruptible(
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
          sql`DELETE FROM worktree_runtime_leases WHERE rowid IN (SELECT rowid FROM worktree_runtime_leases WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = worktree_runtime_leases.thread_id) AND NOT EXISTS (SELECT 1 FROM provider_session_runtime WHERE provider_session_runtime.thread_id = worktree_runtime_leases.thread_id AND provider_session_runtime.status IN ('starting', 'running')) LIMIT ${limit})`,
          sql`DELETE FROM thread_activity_leases WHERE rowid IN (SELECT rowid FROM thread_activity_leases WHERE NOT EXISTS (SELECT 1 FROM projection_threads WHERE projection_threads.thread_id = thread_activity_leases.thread_id) LIMIT ${limit})`,
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
    input.entityKind === "thread"
      ? sql<{
          readonly canonicalCount: number;
          readonly coveredByBaselineSequence: number | null;
          readonly deletionSequence: number | null;
          readonly markerCount: number;
          readonly coveredMarkerCount: number;
          readonly maxCanonicalSequence: number;
        }>`
          WITH root AS (
            SELECT deletion_sequence, covered_by_baseline_sequence
            FROM orchestration_deletion_markers
            WHERE entity_kind = 'thread' AND entity_id = ${input.entityId}
          ), subtree AS (
            SELECT entity_id FROM orchestration_deletion_markers
            WHERE entity_kind = 'thread'
              AND deletion_sequence = (SELECT deletion_sequence FROM root)
          )
          SELECT
            ((SELECT COUNT(*) FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT entity_id FROM subtree)) +
             (SELECT COUNT(*) FROM orchestration_command_receipts
              WHERE aggregate_kind = 'thread'
                AND aggregate_id IN (SELECT entity_id FROM subtree))) AS "canonicalCount",
            (SELECT covered_by_baseline_sequence FROM root) AS "coveredByBaselineSequence",
            (SELECT deletion_sequence FROM root) AS "deletionSequence",
            (SELECT COUNT(*) FROM subtree) AS "markerCount",
            (SELECT COUNT(*) FROM orchestration_deletion_markers AS marker
              JOIN projection_baselines AS baseline
                ON baseline.sequence = marker.covered_by_baseline_sequence
               AND baseline.verification_status = 'verified'
              WHERE marker.entity_kind = 'thread'
                AND marker.entity_id IN (SELECT entity_id FROM subtree)) AS "coveredMarkerCount",
            MAX(
              COALESCE((SELECT MAX(sequence) FROM orchestration_events
                WHERE aggregate_kind = 'thread'
                  AND stream_id IN (SELECT entity_id FROM subtree)), 0),
              COALESCE((SELECT MAX(result_sequence) FROM orchestration_command_receipts
                WHERE aggregate_kind = 'thread'
                  AND aggregate_id IN (SELECT entity_id FROM subtree)), 0)
            ) AS "maxCanonicalSequence"
        `
      : sql<{
          readonly canonicalCount: number;
          readonly coveredByBaselineSequence: number | null;
          readonly deletionSequence: number | null;
          readonly markerCount: number;
          readonly coveredMarkerCount: number;
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
        (SELECT COUNT(*) FROM orchestration_deletion_markers
          WHERE entity_kind = ${input.entityKind} AND entity_id = ${input.entityId})
          AS "markerCount",
        (SELECT COUNT(*) FROM orchestration_deletion_markers AS marker
          JOIN projection_baselines AS baseline
            ON baseline.sequence = marker.covered_by_baseline_sequence
           AND baseline.verification_status = 'verified'
          WHERE marker.entity_kind = ${input.entityKind} AND marker.entity_id = ${input.entityId})
          AS "coveredMarkerCount",
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
    (input.entityKind === "thread"
      ? sql`
        WITH root AS (
          SELECT deletion_sequence FROM orchestration_deletion_markers
          WHERE entity_kind = 'thread' AND entity_id = ${input.entityId}
        )
        DELETE FROM orchestration_command_receipts
        WHERE aggregate_kind = 'thread' AND aggregate_id IN (
          SELECT entity_id FROM orchestration_deletion_markers
          WHERE entity_kind = 'thread'
            AND deletion_sequence = (SELECT deletion_sequence FROM root)
        )
      `
      : sql`
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
    `
    ).pipe(Effect.asVoid);

  const deleteProvenThreadCanonical = ({ threadId }: { readonly threadId: ThreadId }) =>
    sql.withTransaction(
      Effect.all(
        [
          sql`
            WITH root AS (
              SELECT deletion_sequence FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread' AND entity_id = ${threadId}
            )
            DELETE FROM orchestration_event_ids
            WHERE sequence IN (
              SELECT sequence FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id IN (
                SELECT entity_id FROM orchestration_deletion_markers
                WHERE entity_kind = 'thread'
                  AND deletion_sequence = (SELECT deletion_sequence FROM root)
              )
            )
          `,
          sql`
            WITH root AS (
              SELECT deletion_sequence FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread' AND entity_id = ${threadId}
            )
            DELETE FROM orchestration_stream_state
            WHERE aggregate_kind = 'thread' AND stream_id IN (
              SELECT entity_id FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread'
                AND deletion_sequence = (SELECT deletion_sequence FROM root)
            )
          `,
          sql`
            WITH root AS (
              SELECT deletion_sequence FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread' AND entity_id = ${threadId}
            )
            DELETE FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id IN (
              SELECT entity_id FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread'
                AND deletion_sequence = (SELECT deletion_sequence FROM root)
            )
          `,
          sql`
            WITH root AS (
              SELECT deletion_sequence FROM orchestration_deletion_markers
              WHERE entity_kind = 'thread' AND entity_id = ${threadId}
            )
            DELETE FROM orchestration_deletion_markers
            WHERE entity_kind = 'thread'
              AND deletion_sequence = (SELECT deletion_sequence FROM root)
          `,
        ],
        { concurrency: 1, discard: true },
      ),
    );

  return {
    readThreadAssets,
    attachmentIsShared,
    listOtherThreadWorktrees,
    listKnownThreadIds,
    listIncompleteThreadManifests,
    listLiveWorktreeIdentities,
    countThreadRuntimes,
    listProjectThreadIds,
    listDeletionCandidates,
    deleteThreadDependents,
    deleteProjectDependents,
    deleteOrphanRows,
    countThreadRows,
    countProjectRows,
    readCanonicalProof,
    readDeletionMarker,
    deleteProvenReceipts,
    deleteProvenThreadCanonical,
    ...checkpointQueries,
    deleteThreadRoot: ({ threadId }: { readonly threadId: ThreadId }) =>
      sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`.pipe(Effect.asVoid),
    deleteProjectRoot: ({ projectId }: { readonly projectId: ProjectId }) =>
      sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`.pipe(Effect.asVoid),
  };
}
