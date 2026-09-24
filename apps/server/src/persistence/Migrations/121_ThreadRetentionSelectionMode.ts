import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Existing accepted policies and runs retain their subtree selector. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "thread_retention_policy_authority",
    "thread_retention_consent_challenges",
    "thread_retention_runs",
  ]) {
    yield* sql.unsafe(
      `ALTER TABLE ${table} ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'legacy-subtree' CHECK (selection_mode IN ('legacy-subtree', 'per-thread'))`,
    );
    yield* sql.unsafe(
      `ALTER TABLE ${table} ADD COLUMN age_criterion TEXT NOT NULL DEFAULT 'last-conversation-activity' CHECK (age_criterion IN ('created', 'last-conversation-activity'))`,
    );
  }
  yield* sql`
    ALTER TABLE thread_retention_runs ADD COLUMN uncertain_count INTEGER NOT NULL DEFAULT 0
      CHECK (uncertain_count >= 0)
  `;
  yield* sql`
    UPDATE thread_retention_runs SET uncertain_count = (
      SELECT COUNT(*) FROM thread_retention_run_items AS item
      WHERE item.run_id = thread_retention_runs.run_id
        AND item.status IN ('deletion_requested', 'prepared', 'purging')
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_retention_created
    ON projection_threads(created_at, thread_id)
    WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE TABLE direct_resource_cleanup_retained_external (
      operation_id TEXT NOT NULL REFERENCES direct_resource_cleanup_plans(operation_id),
      resource_id TEXT NOT NULL,
      recorded_path TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'retained_external' CHECK (outcome = 'retained_external'),
      classified_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, resource_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_direct_cleanup_intents_source_command
    ON direct_resource_cleanup_intents(source_command_id, intent_id)
  `;
  yield* sql`
    CREATE TABLE managed_attachment_ownership (
      attachment_id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      creator_thread_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('staged', 'published', 'blocked')),
      file_device TEXT,
      file_id TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT,
      blocked_at TEXT,
      blocked_reason TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_managed_attachment_ownership_creator
    ON managed_attachment_ownership(creator_thread_id, lifecycle)
  `;
  yield* sql`
    CREATE TABLE managed_attachment_references (
      source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'activity')),
      source_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      PRIMARY KEY (source_kind, source_id, attachment_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX idx_managed_attachment_references_live
    ON managed_attachment_references(attachment_id, active, thread_id)
  `;
  yield* sql`
    INSERT INTO managed_attachment_references
      (source_kind, source_id, attachment_id, thread_id, active)
    SELECT source_kind, source_id, attachment_id, thread_id, 1
    FROM projection_thread_attachment_refs WHERE is_unresolved = 0
  `;
  yield* sql`
    CREATE TRIGGER managed_attachment_reference_insert
    AFTER INSERT ON projection_thread_attachment_refs WHEN NEW.is_unresolved = 0
    BEGIN
      INSERT INTO managed_attachment_references
        (source_kind, source_id, attachment_id, thread_id, active)
      VALUES (NEW.source_kind, NEW.source_id, NEW.attachment_id, NEW.thread_id, 1)
      ON CONFLICT (source_kind, source_id, attachment_id)
      DO UPDATE SET thread_id = excluded.thread_id, active = 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER managed_attachment_reference_delete
    AFTER DELETE ON projection_thread_attachment_refs WHEN OLD.is_unresolved = 0
    BEGIN
      UPDATE managed_attachment_references SET active = 0
      WHERE source_kind = OLD.source_kind AND source_id = OLD.source_id
        AND attachment_id = OLD.attachment_id;
    END
  `;
  yield* sql`
    CREATE TABLE direct_resource_cleanup_retained_unverified (
      operation_id TEXT NOT NULL REFERENCES direct_resource_cleanup_plans(operation_id),
      resource_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, resource_id)
    )
  `;
});
