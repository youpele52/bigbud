import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE direct_resource_cleanup_intents (
      intent_id TEXT PRIMARY KEY CHECK (length(intent_id) BETWEEN 1 AND 512),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 512),
      source_command_id TEXT NOT NULL CHECK (length(source_command_id) BETWEEN 1 AND 512),
      source_payload_digest_version TEXT NOT NULL CHECK (length(source_payload_digest_version) BETWEEN 1 AND 64),
      source_payload_digest TEXT NOT NULL CHECK (length(source_payload_digest) BETWEEN 1 AND 128),
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'project')),
      entity_id TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 512),
      deletion_mode TEXT NOT NULL CHECK (deletion_mode IN ('single', 'subtree', 'project')),
      deletion_requested_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'completed', 'cancelled', 'blocked')),
      closed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX direct_resource_cleanup_intents_recovery
    ON direct_resource_cleanup_intents(state, deletion_requested_at, intent_id)
  `;
  yield* sql`
    CREATE TABLE direct_resource_cleanup_plans (
      operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 512),
      intent_id TEXT NOT NULL UNIQUE REFERENCES direct_resource_cleanup_intents(intent_id),
      finalize_command_id TEXT NOT NULL UNIQUE CHECK (length(finalize_command_id) BETWEEN 1 AND 512),
      finalize_payload_json TEXT NOT NULL CHECK (json_valid(finalize_payload_json)),
      finalize_payload_digest_version TEXT NOT NULL CHECK (length(finalize_payload_digest_version) BETWEEN 1 AND 64),
      finalize_payload_digest TEXT NOT NULL CHECK (length(finalize_payload_digest) BETWEEN 1 AND 128),
      plan_digest TEXT NOT NULL CHECK (length(plan_digest) BETWEEN 1 AND 128),
      expected_platform TEXT NOT NULL CHECK (expected_platform IN ('darwin/arm64', 'darwin/x64', 'linux/x64', 'win32/x64')),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'ready', 'running', 'retry', 'blocked', 'completed', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      lease_id TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
      CHECK ((state IN ('completed', 'cancelled')) = (completed_at IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE INDEX direct_resource_cleanup_plans_ready
    ON direct_resource_cleanup_plans(state, next_attempt_at, created_at)
  `;
  yield* sql`
    CREATE TABLE direct_resource_cleanup_resources (
      operation_id TEXT NOT NULL REFERENCES direct_resource_cleanup_plans(operation_id),
      resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 512),
      original_index INTEGER NOT NULL CHECK (original_index >= 0),
      page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('attachment', 'provider-log', 'terminal-history', 'project-memory', 'project-notes', 'project-kanban')),
      root_kind TEXT NOT NULL CHECK (root_kind = resource_kind),
      relative_path TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 4096),
      quarantine_name TEXT NOT NULL CHECK (length(quarantine_name) BETWEEN 1 AND 255),
      entry_type TEXT CHECK (entry_type IN ('file', 'directory')),
      resource_device TEXT CHECK (resource_device IS NULL OR length(resource_device) BETWEEN 1 AND 20),
      resource_file_id TEXT CHECK (resource_file_id IS NULL OR length(resource_file_id) BETWEEN 1 AND 20),
      root_device TEXT NOT NULL CHECK (length(root_device) BETWEEN 1 AND 20),
      root_file_id TEXT NOT NULL CHECK (length(root_file_id) BETWEEN 1 AND 20),
      parent_device TEXT NOT NULL CHECK (length(parent_device) BETWEEN 1 AND 20),
      parent_file_id TEXT NOT NULL CHECK (length(parent_file_id) BETWEEN 1 AND 20),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN (
        'removed', 'already_absent', 'resumed_and_removed', 'retained_shared',
        'identity_mismatch', 'unsupported_entry', 'busy', 'permission_denied',
         'deadline_exceeded', 'io_failure', 'process_failure', 'protocol_failure'
      )),
      error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 128),
      terminal_at TEXT,
      CHECK ((entry_type IS NULL AND resource_device IS NULL AND resource_file_id IS NULL) OR
        (entry_type IS NOT NULL AND resource_device IS NOT NULL AND resource_file_id IS NOT NULL)),
      CHECK ((terminal_at IS NULL AND (outcome IS NULL OR outcome IN (
         'busy', 'permission_denied', 'deadline_exceeded', 'io_failure', 'process_failure', 'protocol_failure'
      ))) OR (terminal_at IS NOT NULL AND outcome IN (
        'removed', 'already_absent', 'resumed_and_removed', 'retained_shared',
        'identity_mismatch', 'unsupported_entry'
      ))),
      PRIMARY KEY (operation_id, resource_id),
      UNIQUE (operation_id, original_index)
    )
  `;
  yield* sql`
    CREATE TABLE direct_resource_cleanup_proofs (
      operation_id TEXT PRIMARY KEY REFERENCES direct_resource_cleanup_plans(operation_id),
      receipt_status TEXT NOT NULL CHECK (receipt_status = 'accepted'),
      aggregate_kind TEXT NOT NULL CHECK (aggregate_kind IN ('thread', 'project')),
      aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 512),
      payload_digest_version TEXT NOT NULL CHECK (length(payload_digest_version) BETWEEN 1 AND 64),
      payload_digest TEXT NOT NULL CHECK (length(payload_digest) BETWEEN 1 AND 128),
      event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 512),
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
       event_type TEXT NOT NULL CHECK (event_type IN ('thread.deleted', 'project.deleted')),
       event_payload_json TEXT NOT NULL CHECK (json_valid(event_payload_json)),
       proof_digest TEXT NOT NULL CHECK (length(proof_digest) = 64),
       proven_at TEXT NOT NULL,
      canonical_pruned_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE direct_resource_cleanup_attempts (
      attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 1 AND 1024),
      operation_id TEXT NOT NULL REFERENCES direct_resource_cleanup_plans(operation_id),
      page_ordinal INTEGER NOT NULL CHECK (page_ordinal >= 0),
      page_digest TEXT NOT NULL CHECK (length(page_digest) BETWEEN 1 AND 128),
      resource_ids_json TEXT NOT NULL CHECK (length(resource_ids_json) BETWEEN 2 AND 262144
        AND json_valid(resource_ids_json) AND json_type(resource_ids_json) = 'array'
        AND json_array_length(resource_ids_json) BETWEEN 1 AND 256),
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      request_frame_hex TEXT NOT NULL CHECK (
        length(request_frame_hex) BETWEEN 10 AND 2097160
        AND request_frame_hex NOT GLOB '*[^0-9a-f]*'
      ),
      deadline_unix_ms INTEGER NOT NULL CHECK (deadline_unix_ms > 0),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'sent', 'recorded', 'ambiguous')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (operation_id, page_ordinal, attempt_id)
    )
  `;
  yield* sql`
    CREATE INDEX direct_resource_cleanup_attempts_ambiguous
    ON direct_resource_cleanup_attempts(operation_id, page_ordinal, state, created_at)
  `;

  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_plan_identity_immutable
    BEFORE UPDATE ON direct_resource_cleanup_plans WHEN
      OLD.intent_id IS NOT NEW.intent_id OR OLD.finalize_command_id IS NOT NEW.finalize_command_id OR
      OLD.finalize_payload_json IS NOT NEW.finalize_payload_json OR
      OLD.finalize_payload_digest_version IS NOT NEW.finalize_payload_digest_version OR
      OLD.finalize_payload_digest IS NOT NEW.finalize_payload_digest OR
      OLD.plan_digest IS NOT NEW.plan_digest OR OLD.expected_platform IS NOT NEW.expected_platform OR
      OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'direct cleanup plan identity is immutable'); END
  `;
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_resource_identity_immutable
    BEFORE UPDATE ON direct_resource_cleanup_resources WHEN
      OLD.original_index IS NOT NEW.original_index OR OLD.page_ordinal IS NOT NEW.page_ordinal OR
      OLD.resource_kind IS NOT NEW.resource_kind OR OLD.root_kind IS NOT NEW.root_kind OR
      OLD.relative_path IS NOT NEW.relative_path OR OLD.quarantine_name IS NOT NEW.quarantine_name OR
      OLD.entry_type IS NOT NEW.entry_type OR OLD.resource_device IS NOT NEW.resource_device OR
      OLD.resource_file_id IS NOT NEW.resource_file_id OR OLD.root_device IS NOT NEW.root_device OR
      OLD.root_file_id IS NOT NEW.root_file_id OR OLD.parent_device IS NOT NEW.parent_device OR
      OLD.parent_file_id IS NOT NEW.parent_file_id
    BEGIN SELECT RAISE(ABORT, 'direct cleanup resource identity is immutable'); END
  `;
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_proof_immutable
    BEFORE UPDATE ON direct_resource_cleanup_proofs WHEN
      OLD.receipt_status IS NOT NEW.receipt_status OR OLD.aggregate_kind IS NOT NEW.aggregate_kind OR
      OLD.aggregate_id IS NOT NEW.aggregate_id OR
      OLD.payload_digest_version IS NOT NEW.payload_digest_version OR
      OLD.payload_digest IS NOT NEW.payload_digest OR OLD.event_id IS NOT NEW.event_id OR
      OLD.event_sequence IS NOT NEW.event_sequence OR OLD.event_type IS NOT NEW.event_type OR
      OLD.event_payload_json IS NOT NEW.event_payload_json OR OLD.proven_at IS NOT NEW.proven_at
    BEGIN SELECT RAISE(ABORT, 'direct cleanup proof is immutable'); END
  `;
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_attempt_identity_immutable
    BEFORE UPDATE ON direct_resource_cleanup_attempts WHEN
      OLD.operation_id IS NOT NEW.operation_id OR OLD.page_ordinal IS NOT NEW.page_ordinal OR
       OLD.page_digest IS NOT NEW.page_digest OR OLD.resource_ids_json IS NOT NEW.resource_ids_json OR
       OLD.request_json IS NOT NEW.request_json OR
       OLD.request_frame_hex IS NOT NEW.request_frame_hex OR
       OLD.deadline_unix_ms IS NOT NEW.deadline_unix_ms OR
       OLD.created_at IS NOT NEW.created_at
    BEGIN SELECT RAISE(ABORT, 'direct cleanup attempt identity is immutable'); END
  `;

  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_thread_intent
    AFTER INSERT ON orchestration_events WHEN NEW.event_type = 'thread.deletion-requested'
    BEGIN
       INSERT INTO direct_resource_cleanup_intents (
        intent_id, event_id, source_command_id, source_payload_digest_version,
        source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
      ) VALUES (
        'deletion-intent:' || NEW.event_id, NEW.event_id, NEW.command_id,
         COALESCE((SELECT payload_digest_version FROM orchestration_command_receipt_claims
           WHERE command_id = NEW.command_id), 'legacy/unavailable'),
         COALESCE((SELECT payload_digest FROM orchestration_command_receipt_claims
           WHERE command_id = NEW.command_id), 'unavailable'),
        'thread', json_extract(NEW.payload_json, '$.threadId'),
        COALESCE(json_extract(NEW.payload_json, '$.mode'), 'subtree'), NEW.occurred_at
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER direct_resource_cleanup_project_intent
    AFTER INSERT ON orchestration_events WHEN NEW.event_type = 'project.deletion-requested'
    BEGIN
       INSERT INTO direct_resource_cleanup_intents (
        intent_id, event_id, source_command_id, source_payload_digest_version,
        source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
      ) VALUES (
        'deletion-intent:' || NEW.event_id, NEW.event_id, NEW.command_id,
         COALESCE((SELECT payload_digest_version FROM orchestration_command_receipt_claims
           WHERE command_id = NEW.command_id), 'legacy/unavailable'),
         COALESCE((SELECT payload_digest FROM orchestration_command_receipt_claims
           WHERE command_id = NEW.command_id), 'unavailable'),
        'project', json_extract(NEW.payload_json, '$.projectId'), 'project', NEW.occurred_at
      );
    END
  `;

  yield* sql`
    INSERT INTO direct_resource_cleanup_intents (
      intent_id, event_id, source_command_id, source_payload_digest_version,
      source_payload_digest, entity_kind, entity_id, deletion_mode, deletion_requested_at
    )
    SELECT 'deletion-intent:' || event.event_id, event.event_id, event.command_id,
      COALESCE(claim.payload_digest_version, receipt.payload_digest_version, 'legacy/unavailable'),
      COALESCE(claim.payload_digest, receipt.payload_digest, 'unavailable'),
      event.aggregate_kind, event.stream_id,
      CASE event.aggregate_kind WHEN 'project' THEN 'project'
        ELSE COALESCE(json_extract(event.payload_json, '$.mode'), 'subtree') END,
      event.occurred_at
    FROM orchestration_events AS event
    LEFT JOIN orchestration_command_receipt_claims AS claim ON claim.command_id = event.command_id
    LEFT JOIN orchestration_command_receipts AS receipt ON receipt.command_id = event.command_id
    LEFT JOIN projection_threads AS thread
      ON event.aggregate_kind = 'thread' AND thread.thread_id = event.stream_id
    LEFT JOIN projection_projects AS project
      ON event.aggregate_kind = 'project' AND project.project_id = event.stream_id
    WHERE event.event_type IN ('thread.deletion-requested', 'project.deletion-requested')
      AND ((event.aggregate_kind = 'thread' AND thread.deleting_at IS NOT NULL)
        OR (event.aggregate_kind = 'project' AND project.deleting_at IS NOT NULL))
  `;
});
