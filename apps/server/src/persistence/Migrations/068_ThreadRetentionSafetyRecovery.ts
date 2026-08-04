import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import nodePath from "node:path";

const unavailableEndpoint = (column: string) => `
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
`;
const pathOverlap = (left: string, right: string) => `(
  ${left} IS NOT NULL AND ${right} IS NOT NULL AND (
    ${left} = ${right}
    OR substr(${left}, 1, length(${right}) + 1) = ${right} || '${nodePath.sep}'
    OR substr(${right}, 1, length(${left}) + 1) = ${left} || '${nodePath.sep}'
  )
)`;
const claimedWorktree = (input: {
  readonly threadId: string;
  readonly declaredPath?: string;
  readonly canonicalPath: string;
  readonly device?: string;
  readonly inode?: string;
}) => `
  EXISTS (
    SELECT 1 FROM purge_resource_claims AS claim
    WHERE claim.resource_kind = 'managed-worktree' AND (
      (claim.entity_kind = 'thread' AND claim.entity_id = ${input.threadId})
      ${input.declaredPath ? `OR ${pathOverlap("claim.declared_path", input.declaredPath)}` : ""}
      ${input.declaredPath ? `OR ${pathOverlap("claim.canonical_path", input.declaredPath)}` : ""}
      OR ${pathOverlap("claim.declared_path", input.canonicalPath)}
      OR ${pathOverlap("claim.canonical_path", input.canonicalPath)}
      ${input.device && input.inode ? `OR (claim.device = ${input.device} AND claim.inode = ${input.inode})` : ""}
    )
  )
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TRIGGER thread_retention_guard_runtime_lease_insert`;
  yield* sql`DROP TRIGGER thread_retention_guard_runtime_lease_update`;
  yield* sql.unsafe(`
    CREATE TRIGGER thread_retention_guard_runtime_lease_insert
    BEFORE INSERT ON worktree_runtime_leases WHEN ${unavailableEndpoint("thread_id")}
      OR ${claimedWorktree({ threadId: "NEW.thread_id", canonicalPath: "NEW.canonical_path", device: "NEW.device", inode: "NEW.inode" })}
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER thread_retention_guard_runtime_lease_update
    BEFORE UPDATE OF thread_id, canonical_path, device, inode ON worktree_runtime_leases
    WHEN ${unavailableEndpoint("thread_id")}
      OR ${claimedWorktree({ threadId: "NEW.thread_id", canonicalPath: "NEW.canonical_path", device: "NEW.device", inode: "NEW.inode" })}
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `);

  yield* sql`DROP TRIGGER thread_retention_guard_worktree_insert`;
  yield* sql`DROP TRIGGER thread_retention_guard_worktree_update`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN worktree_canonical_path TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN worktree_device INTEGER`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN worktree_inode INTEGER`;
  yield* sql.unsafe(`
    CREATE TRIGGER thread_retention_guard_worktree_insert
    BEFORE INSERT ON projection_threads WHEN NEW.worktree_path IS NOT NULL AND (
      ${unavailableEndpoint("thread_id")} OR ${claimedWorktree({ threadId: "NEW.thread_id", declaredPath: "NEW.worktree_path", canonicalPath: "NEW.worktree_canonical_path", device: "NEW.worktree_device", inode: "NEW.worktree_inode" })}
    ) BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER thread_retention_guard_worktree_update
    BEFORE UPDATE OF worktree_path, worktree_canonical_path, worktree_device, worktree_inode ON projection_threads
    WHEN NEW.worktree_path IS NOT NULL AND (
      NEW.worktree_path IS NOT OLD.worktree_path
      OR NEW.worktree_canonical_path IS NOT OLD.worktree_canonical_path
      OR NEW.worktree_device IS NOT OLD.worktree_device
      OR NEW.worktree_inode IS NOT OLD.worktree_inode
    ) AND (
      ${unavailableEndpoint("thread_id")} OR ${claimedWorktree({ threadId: "NEW.thread_id", declaredPath: "NEW.worktree_path", canonicalPath: "NEW.worktree_canonical_path", device: "NEW.worktree_device", inode: "NEW.worktree_inode" })}
    ) BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `);

  yield* sql`DROP TRIGGER thread_retention_guard_provider_runtime_insert`;
  yield* sql`DROP TRIGGER thread_retention_guard_provider_runtime_update`;
  yield* sql.unsafe(`
    CREATE TRIGGER thread_retention_guard_provider_runtime_insert
    BEFORE INSERT ON provider_session_runtime WHEN NEW.status IN ('starting', 'running')
      AND ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'provider runtime conflicts with purge'); END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER thread_retention_guard_provider_runtime_update
    BEFORE UPDATE OF status, thread_id ON provider_session_runtime
    WHEN NEW.status IN ('starting', 'running') AND ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'provider runtime conflicts with purge'); END
  `);

  yield* sql`DROP TRIGGER thread_retention_guard_learning_job_insert`;
  yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_learning_job_update`;
  yield* sql`DROP TRIGGER thread_retention_guard_skill_proposal_insert`;
  yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_skill_proposal_update`;
  for (const [table, name] of [
    ["learning_jobs", "learning_job"],
    ["skill_change_proposals", "skill_proposal"],
  ]) {
    yield* sql.unsafe(`CREATE TRIGGER thread_retention_guard_${name}_insert
      BEFORE INSERT ON ${table} WHEN ${unavailableEndpoint("thread_id")}
      BEGIN SELECT RAISE(ABORT, '${name} thread is deleting'); END`);
    yield* sql.unsafe(`CREATE TRIGGER thread_retention_guard_${name}_update
      BEFORE UPDATE ON ${table} WHEN ${unavailableEndpoint("thread_id")}
      BEGIN SELECT RAISE(ABORT, '${name} thread is deleting'); END`);
  }

  yield* sql`
    UPDATE purge_jobs SET status = 'failed', last_error = 'manual_recovery_required',
      updated_at = CURRENT_TIMESTAMP, execution_lease_id = NULL, execution_lease_expires_at = NULL
    WHERE entity_kind = 'thread' AND status IN ('pending', 'running', 'failed')
      AND phase IN ('marking', 'database', 'files', 'verifying', 'root')
      AND NOT EXISTS (
        SELECT 1 FROM purge_checkpoint_ref_sets AS checkpoint_set
        WHERE checkpoint_set.job_id = purge_jobs.job_id AND checkpoint_set.verified_at IS NOT NULL
      )
  `;
});
