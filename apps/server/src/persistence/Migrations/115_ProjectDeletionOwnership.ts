import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts/constants/project.constant.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX IF NOT EXISTS bootstrap_recipes_project_id
    ON orchestration_bootstrap_recipes (project_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_delegations_target_project_id
    ON thread_delegations (target_project_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS thread_delegations_created_project_id
    ON thread_delegations (created_project_id)`;

  // Older project proofs marked pruning complete before any canonical rows were removed.
  // Only reopen checkpoints with matching retained deletion evidence, never completed prunes.
  yield* sql`
    UPDATE direct_resource_cleanup_proofs AS proof SET canonical_pruned_at = NULL
    WHERE proof.aggregate_kind = 'project' AND proof.receipt_status = 'accepted'
      AND proof.event_type = 'project.deleted' AND proof.canonical_pruned_at IS NOT NULL
      AND json_extract(proof.event_payload_json, '$.projectId') = proof.aggregate_id
      AND NOT EXISTS (SELECT 1 FROM projection_projects AS project
        WHERE project.project_id = proof.aggregate_id AND project.deleted_at IS NULL)
      AND (
        EXISTS (SELECT 1 FROM orchestration_deletion_markers AS marker
          WHERE marker.entity_kind = 'project' AND marker.entity_id = proof.aggregate_id
            AND marker.deletion_sequence = proof.event_sequence
            AND marker.deleted_at = json_extract(proof.event_payload_json, '$.deletedAt'))
        OR EXISTS (SELECT 1 FROM orchestration_events AS event
          WHERE event.event_id = proof.event_id AND event.sequence = proof.event_sequence
            AND event.aggregate_kind = 'project' AND event.stream_id = proof.aggregate_id
            AND event.event_type = 'project.deleted'
            AND event.payload_json = proof.event_payload_json)
      )
  `;

  yield* sql`CREATE TEMP TABLE project_deletion_backfill (project_id TEXT PRIMARY KEY)`;
  yield* sql`
    INSERT INTO project_deletion_backfill (project_id)
    SELECT DISTINCT marker.entity_id FROM orchestration_deletion_markers AS marker
    WHERE marker.entity_kind = 'project'
      AND marker.entity_id <> ${BUILT_IN_CHATS_PROJECT_ID}
      AND NOT EXISTS (SELECT 1 FROM projection_projects
        WHERE projection_projects.project_id = marker.entity_id)
  `;
  yield* sql`DELETE FROM projection_notes
    WHERE project_id IN (SELECT project_id FROM project_deletion_backfill)`;
  yield* sql`DELETE FROM automation_schedules
    WHERE project_id IN (SELECT project_id FROM project_deletion_backfill)`;
  yield* sql`DELETE FROM remote_agent_restart_requests
    WHERE project_id IN (SELECT project_id FROM project_deletion_backfill)`;
  yield* sql`DELETE FROM orchestration_bootstrap_recipes
    WHERE project_id IN (SELECT project_id FROM project_deletion_backfill)`;
  yield* sql`UPDATE thread_delegations SET target_project_id = NULL
    WHERE target_project_id IN (SELECT project_id FROM project_deletion_backfill)`;
  yield* sql`UPDATE thread_delegations SET created_project_id = NULL
    WHERE created_project_id IN (SELECT project_id FROM project_deletion_backfill)`;

  yield* sql`CREATE TEMP TABLE project_deletion_threads (thread_id TEXT PRIMARY KEY)`;
  yield* sql`
    INSERT INTO project_deletion_threads (thread_id)
    SELECT thread_id FROM projection_threads
    WHERE project_id IN (SELECT project_id FROM project_deletion_backfill)
      AND NOT EXISTS (
        SELECT 1 FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_threads.thread_id
          AND provider_session_runtime.status IN ('starting', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM thread_activity_leases
        WHERE thread_activity_leases.thread_id = projection_threads.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM worktree_runtime_leases
        WHERE worktree_runtime_leases.thread_id = projection_threads.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM automation_schedules
        WHERE automation_schedules.target_thread_id = projection_threads.thread_id
          AND (automation_schedules.project_id IS NULL
            OR automation_schedules.project_id <> projection_threads.project_id)
      )
  `;
  yield* sql`
    UPDATE projection_threads SET parent_thread_id = NULL,
      parent_thread_title = NULL, parent_thread_project_id = NULL
    WHERE parent_thread_id IN (SELECT thread_id FROM project_deletion_threads)
      AND thread_id NOT IN (SELECT thread_id FROM project_deletion_threads)
  `;
  yield* sql`DELETE FROM projection_threads
    WHERE thread_id IN (SELECT thread_id FROM project_deletion_threads)`;
  yield* sql`DROP TABLE project_deletion_threads`;
  yield* sql`DROP TABLE project_deletion_backfill`;
});
