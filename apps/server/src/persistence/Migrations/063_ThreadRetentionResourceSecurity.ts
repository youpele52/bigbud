import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export function addThreadRetentionResourceSecurity(sql: SqlClient.SqlClient) {
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
  return Effect.gen(function* () {
    yield* sql`
    CREATE TABLE purge_resource_claims (
      job_id TEXT NOT NULL,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'project')),
      entity_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('attachment', 'managed-worktree', 'provider-log', 'terminal-history', 'project-memory', 'project-notes', 'project-kanban')),
      relative_path TEXT NOT NULL,
      attachment_id TEXT,
      declared_path TEXT,
      canonical_path TEXT NOT NULL,
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'directory')),
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (job_id, resource_kind, relative_path),
      UNIQUE (canonical_path),
      UNIQUE (device, inode),
      FOREIGN KEY (job_id) REFERENCES purge_jobs(job_id) ON DELETE CASCADE
    )
  `;
    yield* sql`
    CREATE INDEX idx_purge_resource_claims_entity
    ON purge_resource_claims(entity_kind, entity_id, resource_kind)
  `;
    yield* sql`
    CREATE TABLE purge_checkpoint_ref_sets (
      job_id TEXT PRIMARY KEY,
      workspace_cwd TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      FOREIGN KEY (job_id) REFERENCES purge_jobs(job_id) ON DELETE CASCADE
    )
  `;
    yield* sql`
    CREATE TABLE purge_checkpoint_refs (
      job_id TEXT NOT NULL,
      workspace_cwd TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      PRIMARY KEY (job_id, checkpoint_ref),
      FOREIGN KEY (job_id) REFERENCES purge_jobs(job_id) ON DELETE CASCADE
    )
  `;
    yield* sql`
    CREATE TABLE worktree_runtime_leases (
      lease_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('terminal', 'shell', 'provider')),
      canonical_path TEXT NOT NULL,
      device INTEGER NOT NULL,
      inode INTEGER NOT NULL,
      process_id INTEGER,
      acquired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (runtime_kind, thread_id, canonical_path)
    )
  `;
    yield* sql`
    CREATE TABLE thread_activity_leases (
      lease_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      activity_kind TEXT NOT NULL CHECK (activity_kind IN ('computer-use')),
      acquired_at TEXT NOT NULL
    )
  `;
    yield* sql`
    CREATE INDEX idx_thread_activity_leases_thread
    ON thread_activity_leases(thread_id)
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_activity_lease_insert
    BEFORE INSERT ON thread_activity_leases WHEN ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread is claimed or marked for deletion'); END
  `;
    yield* sql`
    CREATE INDEX idx_worktree_runtime_leases_identity
    ON worktree_runtime_leases(device, inode, canonical_path)
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_runtime_lease_insert
    BEFORE INSERT ON worktree_runtime_leases WHEN ${unavailableEndpoint("thread_id")} OR EXISTS (
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.resource_kind = 'managed-worktree' 
    )
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_runtime_lease_update
    BEFORE UPDATE OF thread_id, canonical_path, device, inode ON worktree_runtime_leases
    WHEN ${unavailableEndpoint("thread_id")} OR EXISTS (
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.resource_kind = 'managed-worktree' 
    )
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;

    const activeWorktreeClaim = sql.unsafe(`
    EXISTS (SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.resource_kind = 'managed-worktree')
  `);
    yield* sql`
    CREATE TRIGGER thread_retention_guard_worktree_insert
    BEFORE INSERT ON projection_threads
    WHEN NEW.worktree_path IS NOT NULL AND ${activeWorktreeClaim}
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_worktree_update
    BEFORE UPDATE OF worktree_path ON projection_threads
    WHEN NEW.worktree_path IS NOT NULL
      AND NEW.worktree_path IS NOT OLD.worktree_path
      AND ${activeWorktreeClaim}
    BEGIN SELECT RAISE(ABORT, 'worktree resource is claimed for purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_provider_runtime_insert
    BEFORE INSERT ON provider_session_runtime
    WHEN NEW.status IN ('starting', 'running') AND (
      ${unavailableEndpoint("thread_id")} OR EXISTS (
        SELECT 1 FROM projection_threads AS thread
        WHERE thread.thread_id = NEW.thread_id AND thread.worktree_path IS NOT NULL
           AND EXISTS (SELECT 1 FROM purge_resource_claims
             WHERE resource_kind = 'managed-worktree'
               AND (declared_path = thread.worktree_path OR canonical_path = thread.worktree_path))
      )
    )
    BEGIN SELECT RAISE(ABORT, 'provider runtime conflicts with purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_provider_runtime_update
    BEFORE UPDATE OF status, thread_id ON provider_session_runtime
    WHEN NEW.status IN ('starting', 'running') AND (
      ${unavailableEndpoint("thread_id")} OR EXISTS (
        SELECT 1 FROM projection_threads AS thread
        WHERE thread.thread_id = NEW.thread_id AND thread.worktree_path IS NOT NULL
           AND EXISTS (SELECT 1 FROM purge_resource_claims
             WHERE resource_kind = 'managed-worktree'
               AND (declared_path = thread.worktree_path OR canonical_path = thread.worktree_path))
      )
    )
    BEGIN SELECT RAISE(ABORT, 'provider runtime conflicts with purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_parent_insert
    BEFORE INSERT ON projection_threads
    WHEN NEW.parent_thread_id IS NOT NULL AND ${unavailableEndpoint("parent_thread_id")}
    BEGIN SELECT RAISE(ABORT, 'parent thread is deleting'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_parent_update
    BEFORE UPDATE OF parent_thread_id ON projection_threads
    WHEN NEW.parent_thread_id IS NOT NULL AND ${unavailableEndpoint("parent_thread_id")}
    BEGIN SELECT RAISE(ABORT, 'parent thread is deleting'); END
  `;

    yield* sql`
    CREATE TRIGGER thread_retention_guard_message_endpoint_insert
    BEFORE INSERT ON projection_thread_messages WHEN ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_message_endpoint_update
    BEFORE UPDATE OF thread_id, attachments_json ON projection_thread_messages
    WHEN ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_activity_endpoint_insert
    BEFORE INSERT ON projection_thread_activities WHEN ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_activity_endpoint_update
    BEFORE UPDATE OF thread_id, payload_json ON projection_thread_activities
    WHEN ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_message_attachment_insert
    BEFORE INSERT ON projection_thread_messages WHEN NEW.attachments_json IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(NEW.attachments_json) AS attachment
      JOIN purge_resource_claims AS claim
        ON claim.resource_kind = 'attachment'
       AND claim.attachment_id = json_extract(attachment.value, '$.id')
      WHERE claim.entity_id <> NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'attachment resource is claimed for purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_message_attachment_update
    BEFORE UPDATE OF attachments_json, thread_id ON projection_thread_messages
    WHEN NEW.attachments_json IS NOT NULL AND EXISTS (
      SELECT 1 FROM json_each(NEW.attachments_json) AS attachment
      JOIN purge_resource_claims AS claim
        ON claim.resource_kind = 'attachment'
       AND claim.attachment_id = json_extract(attachment.value, '$.id')
      WHERE claim.entity_id <> NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'attachment resource is claimed for purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_activity_attachment_insert
    BEFORE INSERT ON projection_thread_activities WHEN EXISTS (
      SELECT 1 FROM json_tree(NEW.payload_json) AS node
      JOIN purge_resource_claims AS claim
        ON claim.resource_kind = 'attachment' AND claim.attachment_id = node.value
      WHERE node.key = 'attachmentId' AND claim.entity_id <> NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'activity attachment resource is claimed for purge'); END
  `;
    yield* sql`
    CREATE TRIGGER thread_retention_guard_activity_attachment_update
    BEFORE UPDATE OF payload_json, thread_id ON projection_thread_activities WHEN EXISTS (
      SELECT 1 FROM json_tree(NEW.payload_json) AS node
      JOIN purge_resource_claims AS claim
        ON claim.resource_kind = 'attachment' AND claim.attachment_id = node.value
      WHERE node.key = 'attachmentId' AND claim.entity_id <> NEW.thread_id
    )
    BEGIN SELECT RAISE(ABORT, 'activity attachment resource is claimed for purge'); END
  `;
  });
}
