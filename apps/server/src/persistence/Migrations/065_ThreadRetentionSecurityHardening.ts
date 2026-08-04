import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const unavailableEndpoint = (column: string) =>
    sql.unsafe(`
      EXISTS (
        SELECT 1 FROM projection_threads AS endpoint
        WHERE endpoint.thread_id = NEW.${column}
          AND (endpoint.deleting_at IS NOT NULL OR endpoint.deleted_at IS NOT NULL)
      ) OR EXISTS (
        SELECT 1 FROM thread_retention_run_items AS item
        WHERE item.thread_id = NEW.${column}
          AND item.status IN ('deletion_requested', 'prepared', 'purging', 'completed')
      ) OR EXISTS (
        SELECT 1 FROM orchestration_deletion_markers AS marker
        WHERE marker.entity_kind = 'thread' AND marker.entity_id = NEW.${column}
      ) OR EXISTS (
        SELECT 1 FROM purge_resource_claims AS claim
        WHERE claim.entity_kind = 'thread' AND claim.entity_id = NEW.${column}
      )
    `);
  const overlappingManagedWorktree = (threadColumn: string, pathColumn?: string) =>
    sql.unsafe(`
      EXISTS (
        SELECT 1 FROM purge_resource_claims AS claim
        WHERE claim.resource_kind = 'managed-worktree'
          AND (
            (claim.entity_kind = 'thread' AND claim.entity_id = NEW.${threadColumn})
            ${pathColumn ? `OR claim.declared_path = NEW.${pathColumn} OR claim.canonical_path = NEW.${pathColumn}` : ""}
          )
      )
    `);

  yield* sql`ALTER TABLE purge_jobs ADD COLUMN resource_manifest_digest TEXT`;
  yield* sql`ALTER TABLE purge_jobs ADD COLUMN manifest_sealed_at TEXT`;
  yield* sql`
    CREATE TRIGGER purge_manifest_sealed_immutable
    BEFORE UPDATE OF resource_manifest_json, resource_manifest_digest ON purge_jobs
    WHEN OLD.manifest_sealed_at IS NOT NULL AND (
      NEW.resource_manifest_json IS NOT OLD.resource_manifest_json
      OR NEW.resource_manifest_digest IS NOT OLD.resource_manifest_digest
    )
    BEGIN SELECT RAISE(ABORT, 'sealed purge manifest is immutable'); END
  `;
  yield* sql`
    CREATE TRIGGER purge_manifest_seal_before_complete
    BEFORE UPDATE OF status ON purge_jobs
    WHEN NEW.status = 'completed'
      AND (NEW.manifest_sealed_at IS NULL OR NEW.resource_manifest_digest IS NULL)
    BEGIN SELECT RAISE(ABORT, 'purge manifest is not sealed'); END
  `;

  yield* sql`DROP TRIGGER thread_retention_guard_activity_lease_insert`;
  yield* sql`ALTER TABLE thread_activity_leases RENAME TO thread_activity_leases_legacy`;
  yield* sql`
    CREATE TABLE thread_activity_leases (
      lease_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      activity_kind TEXT NOT NULL CHECK (activity_kind IN ('browser', 'computer-use')),
      acquired_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
    SELECT lease_id, thread_id, activity_kind, acquired_at FROM thread_activity_leases_legacy
  `;
  yield* sql`DROP TABLE thread_activity_leases_legacy`;
  yield* sql`CREATE INDEX idx_thread_activity_leases_thread ON thread_activity_leases(thread_id)`;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_activity_lease_insert
    BEFORE INSERT ON thread_activity_leases WHEN EXISTS (
      SELECT 1 FROM projection_threads AS thread
      WHERE thread.thread_id = NEW.thread_id
        AND (thread.deleting_at IS NOT NULL OR thread.deleted_at IS NOT NULL)
    ) OR EXISTS (
      SELECT 1 FROM orchestration_deletion_markers AS marker
      WHERE marker.entity_kind = 'thread' AND marker.entity_id = NEW.thread_id
    ) OR EXISTS (
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.entity_kind = 'thread' AND claim.entity_id = NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'thread is claimed or marked for deletion'); END
  `;

  yield* sql`DROP TRIGGER thread_retention_guard_runtime_lease_insert`;
  yield* sql`DROP TRIGGER thread_retention_guard_runtime_lease_update`;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_runtime_lease_insert
    BEFORE INSERT ON worktree_runtime_leases WHEN ${unavailableEndpoint("thread_id")} OR
      ${overlappingManagedWorktree("thread_id")} OR EXISTS (
        SELECT 1 FROM purge_resource_claims AS claim
        WHERE claim.resource_kind = 'managed-worktree'
          AND (claim.canonical_path = NEW.canonical_path
            OR (claim.device = NEW.device AND claim.inode = NEW.inode))
      )
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_runtime_lease_update
    BEFORE UPDATE OF thread_id, canonical_path, device, inode ON worktree_runtime_leases
    WHEN ${unavailableEndpoint("thread_id")} OR ${overlappingManagedWorktree("thread_id")} OR EXISTS (
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.resource_kind = 'managed-worktree'
        AND (claim.canonical_path = NEW.canonical_path
          OR (claim.device = NEW.device AND claim.inode = NEW.inode))
    )
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;

  yield* sql`DROP TRIGGER thread_retention_guard_worktree_insert`;
  yield* sql`DROP TRIGGER thread_retention_guard_worktree_update`;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_worktree_insert
    BEFORE INSERT ON projection_threads WHEN NEW.worktree_path IS NOT NULL AND (
      ${unavailableEndpoint("thread_id")} OR ${overlappingManagedWorktree("thread_id", "worktree_path")}
    )
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_worktree_update
    BEFORE UPDATE OF worktree_path ON projection_threads
    WHEN NEW.worktree_path IS NOT OLD.worktree_path AND (
      ${unavailableEndpoint("thread_id")} OR (
        NEW.worktree_path IS NOT NULL AND ${overlappingManagedWorktree("thread_id", "worktree_path")}
      )
    )
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;

  yield* sql`DROP TRIGGER thread_retention_guard_provider_runtime_insert`;
  yield* sql`DROP TRIGGER thread_retention_guard_provider_runtime_update`;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_provider_runtime_insert
    BEFORE INSERT ON provider_session_runtime WHEN NEW.status IN ('starting', 'running') AND (
      ${unavailableEndpoint("thread_id")} OR ${overlappingManagedWorktree("thread_id")}
    )
    BEGIN SELECT RAISE(ABORT, 'provider runtime conflicts with purge'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_provider_runtime_update
    BEFORE UPDATE OF status, thread_id ON provider_session_runtime
    WHEN NEW.status IN ('starting', 'running') AND (
      ${unavailableEndpoint("thread_id")} OR ${overlappingManagedWorktree("thread_id")}
    )
    BEGIN SELECT RAISE(ABORT, 'provider runtime conflicts with purge'); END
  `;

  yield* sql`
    CREATE TRIGGER thread_retention_guard_learning_job_insert
    BEFORE INSERT ON learning_jobs WHEN EXISTS (
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.entity_kind = 'thread' AND claim.entity_id = NEW.thread_id
    ) OR EXISTS (
      SELECT 1 FROM orchestration_deletion_markers AS marker
      WHERE marker.entity_kind = 'thread' AND marker.entity_id = NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'learning job thread is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_skill_proposal_insert
    BEFORE INSERT ON skill_change_proposals WHEN EXISTS (
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.entity_kind = 'thread' AND claim.entity_id = NEW.thread_id
    ) OR EXISTS (
      SELECT 1 FROM orchestration_deletion_markers AS marker
      WHERE marker.entity_kind = 'thread' AND marker.entity_id = NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'skill proposal thread is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_source_plan_insert
    BEFORE INSERT ON projection_turns WHEN NEW.source_proposed_plan_thread_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM orchestration_deletion_markers AS marker
      WHERE marker.entity_kind = 'thread' AND marker.entity_id = NEW.source_proposed_plan_thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'source plan thread is deleting'); END
  `;
});
