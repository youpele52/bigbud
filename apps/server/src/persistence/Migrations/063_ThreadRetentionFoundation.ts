import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { addThreadRetentionResourceSecurity } from "./063_ThreadRetentionResourceSecurity.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''
  `;
  yield* sql`
    UPDATE projection_threads AS thread
    SET last_activity_at = (
      SELECT MAX(activity_at)
      FROM (
        SELECT thread.created_at AS activity_at
        UNION ALL SELECT thread.updated_at
        UNION ALL SELECT message.created_at FROM projection_thread_messages AS message WHERE message.thread_id = thread.thread_id
        UNION ALL SELECT message.updated_at FROM projection_thread_messages AS message WHERE message.thread_id = thread.thread_id
        UNION ALL SELECT activity.created_at FROM projection_thread_activities AS activity WHERE activity.thread_id = thread.thread_id
        UNION ALL SELECT plan.created_at FROM projection_thread_proposed_plans AS plan WHERE plan.thread_id = thread.thread_id
        UNION ALL SELECT plan.updated_at FROM projection_thread_proposed_plans AS plan WHERE plan.thread_id = thread.thread_id
        UNION ALL SELECT task.created_at FROM projection_thread_tasks AS task WHERE task.thread_id = thread.thread_id
        UNION ALL SELECT task.updated_at FROM projection_thread_tasks AS task WHERE task.thread_id = thread.thread_id
        UNION ALL SELECT session.updated_at FROM projection_thread_sessions AS session WHERE session.thread_id = thread.thread_id
        UNION ALL SELECT turn.requested_at FROM projection_turns AS turn WHERE turn.thread_id = thread.thread_id
        UNION ALL SELECT turn.started_at FROM projection_turns AS turn WHERE turn.thread_id = thread.thread_id
        UNION ALL SELECT turn.completed_at FROM projection_turns AS turn WHERE turn.thread_id = thread.thread_id
        UNION ALL SELECT approval.created_at FROM projection_pending_approvals AS approval WHERE approval.thread_id = thread.thread_id
        UNION ALL SELECT approval.resolved_at FROM projection_pending_approvals AS approval WHERE approval.thread_id = thread.thread_id
        UNION ALL SELECT user_input.created_at FROM projection_pending_user_inputs AS user_input WHERE user_input.thread_id = thread.thread_id
        UNION ALL SELECT user_input.resolved_at FROM projection_pending_user_inputs AS user_input WHERE user_input.thread_id = thread.thread_id
        UNION ALL
        SELECT json_extract(prompt.value, '$.createdAt')
        FROM json_each(thread.queued_prompts_json) AS prompt
        WHERE json_type(prompt.value, '$.createdAt') = 'text'
      )
      WHERE activity_at IS NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_projection_threads_retention_scan
    ON projection_threads(last_activity_at ASC, thread_id ASC)
    WHERE deleted_at IS NULL AND deleting_at IS NULL AND pinned_at IS NULL
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_tasks_active_thread
    ON projection_thread_tasks(thread_id)
    WHERE json_extract(task_json, '$.status') IN ('pending', 'inProgress')
  `;
  yield* sql`
    CREATE INDEX idx_thread_delegations_active_caller
    ON thread_delegations(caller_thread_id, state)
  `;
  yield* sql`
    CREATE INDEX idx_thread_delegations_active_child
    ON thread_delegations(child_thread_id, state)
  `;

  yield* sql`
    CREATE TABLE thread_retention_rollout (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      had_user_threads INTEGER NOT NULL CHECK (had_user_threads IN (0, 1)),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO thread_retention_rollout (singleton_id, had_user_threads, created_at)
    SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM projection_threads) THEN 1 ELSE 0 END,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `;

  yield* sql`
    CREATE TABLE thread_retention_runs (
      run_id TEXT PRIMARY KEY,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled')),
      policy TEXT NOT NULL CHECK (policy IN ('7-days', '14-days', '30-days', '90-days')),
      cutoff_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'selecting', 'preparing', 'purging', 'deferred', 'completed', 'completed_with_failures', 'failed', 'cancelled')),
      active_slot INTEGER CHECK (active_slot = 1),
      cursor_last_activity_at TEXT,
      cursor_thread_id TEXT,
      eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
      selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
      skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
      requested_count INTEGER NOT NULL DEFAULT 0 CHECK (requested_count >= 0),
      completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
      failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
      estimated_resource_count INTEGER NOT NULL DEFAULT 0 CHECK (estimated_resource_count >= 0),
      required_baseline_sequence INTEGER,
      next_attempt_at TEXT,
      last_error_code TEXT,
      retry_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (retry_ordinal >= 0),
      failure_window_started_at TEXT,
      failure_count_in_window INTEGER NOT NULL DEFAULT 0 CHECK (failure_count_in_window >= 0),
      last_failure_at TEXT,
      circuit_open_until TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_thread_retention_runs_active_slot
    ON thread_retention_runs(active_slot) WHERE active_slot = 1
  `;
  yield* sql`
    CREATE INDEX idx_thread_retention_runs_recent
    ON thread_retention_runs(created_at DESC, run_id DESC)
  `;
  yield* sql`
    CREATE INDEX idx_thread_retention_runs_circuit
    ON thread_retention_runs(circuit_open_until)
    WHERE circuit_open_until IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE thread_retention_run_items (
      run_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      expected_last_activity_at TEXT NOT NULL,
      deletion_command_id TEXT NOT NULL UNIQUE,
      purge_job_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('selected', 'deletion_requested', 'prepared', 'purging', 'completed', 'skipped', 'failed')),
      exclusion_reason TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (run_id, thread_id),
      FOREIGN KEY (run_id) REFERENCES thread_retention_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_thread_retention_items_recoverable
    ON thread_retention_run_items(status, updated_at, run_id, thread_id)
  `;
  yield* sql`
    CREATE TABLE thread_retention_failures (
      run_id TEXT NOT NULL,
      retry_ordinal INTEGER NOT NULL CHECK (retry_ordinal > 0),
      failed_at TEXT NOT NULL,
      error_code TEXT NOT NULL,
      PRIMARY KEY (run_id, failed_at),
      FOREIGN KEY (run_id) REFERENCES thread_retention_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX idx_thread_retention_failures_recent
    ON thread_retention_failures(failed_at DESC, run_id, retry_ordinal)
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_run_status_monotonic
    BEFORE UPDATE OF status ON thread_retention_runs
    WHEN NOT (
      (OLD.status = 'queued' AND NEW.status IN ('selecting', 'deferred', 'completed', 'failed', 'cancelled'))
      OR (OLD.status = 'selecting' AND NEW.status IN ('preparing', 'deferred', 'completed', 'failed', 'cancelled'))
      OR (OLD.status = 'preparing' AND NEW.status IN ('purging', 'deferred', 'completed_with_failures', 'failed', 'cancelled'))
      OR (OLD.status = 'purging' AND NEW.status IN ('deferred', 'completed', 'completed_with_failures', 'failed', 'cancelled'))
      OR (OLD.status = 'deferred' AND NEW.status IN ('selecting', 'preparing', 'purging', 'completed', 'completed_with_failures', 'failed', 'cancelled'))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid retention run status transition'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_item_status_monotonic
    BEFORE UPDATE OF status ON thread_retention_run_items
    WHEN NOT (
      (OLD.status = 'selected' AND NEW.status IN ('deletion_requested', 'skipped', 'failed'))
      OR (OLD.status = 'deletion_requested' AND NEW.status IN ('prepared', 'skipped', 'failed'))
      OR (OLD.status = 'prepared' AND NEW.status IN ('purging', 'failed'))
      OR (OLD.status = 'purging' AND NEW.status IN ('completed', 'failed'))
    )
    BEGIN SELECT RAISE(ABORT, 'invalid retention item status transition'); END
  `;

  yield* sql`
    CREATE TABLE thread_retention_consent_challenges (
      challenge_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'policy-change')),
      policy TEXT NOT NULL CHECK (policy IN ('7-days', '14-days', '30-days', '90-days')),
      cutoff_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_thread_retention_challenges_expiry
    ON thread_retention_consent_challenges(expires_at, challenge_id)
  `;

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
      SELECT 1 FROM purge_resource_claims AS claim
      WHERE claim.entity_kind = 'thread' AND claim.entity_id = NEW.${column}
    ) OR EXISTS (
      SELECT 1 FROM orchestration_deletion_markers AS marker
      WHERE marker.entity_kind = 'thread' AND marker.entity_id = NEW.${column}
    )
  `);
  yield* sql`
    CREATE TRIGGER thread_retention_guard_watch_insert
    BEFORE INSERT ON projection_thread_watches WHEN NEW.status = 'active'
      AND (${unavailableEndpoint("watcher_thread_id")} OR ${unavailableEndpoint("watched_thread_id")})
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_watch_activate
    BEFORE UPDATE OF status, watcher_thread_id, watched_thread_id ON projection_thread_watches
      WHEN NEW.status = 'active'
        AND (${unavailableEndpoint("watcher_thread_id")} OR ${unavailableEndpoint("watched_thread_id")})
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_delegation_insert
    BEFORE INSERT ON thread_delegations
      WHEN NEW.state NOT IN ('completed', 'compensated', 'failed')
        AND (${unavailableEndpoint("caller_thread_id")} OR ${unavailableEndpoint("child_thread_id")})
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_delegation_activate
    BEFORE UPDATE OF state, caller_thread_id, child_thread_id ON thread_delegations
      WHEN NEW.state NOT IN ('completed', 'compensated', 'failed')
        AND (${unavailableEndpoint("caller_thread_id")} OR ${unavailableEndpoint("child_thread_id")})
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_automation_insert
    BEFORE INSERT ON automation_schedules
      WHEN NEW.deleted_at IS NULL AND NEW.completed_at IS NULL AND NEW.paused_at IS NULL
        AND ${unavailableEndpoint("target_thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_automation_activate
    BEFORE UPDATE OF target_thread_id, next_run_at, paused_at, completed_at, deleted_at ON automation_schedules
      WHEN NEW.deleted_at IS NULL AND NEW.completed_at IS NULL AND NEW.paused_at IS NULL
        AND ${unavailableEndpoint("target_thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_automation_run_insert
    BEFORE INSERT ON automation_runs WHEN NEW.status = 'started'
      AND ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_automation_run_activate
    BEFORE UPDATE OF status, thread_id ON automation_runs WHEN NEW.status = 'started'
      AND ${unavailableEndpoint("thread_id")}
    BEGIN SELECT RAISE(ABORT, 'thread endpoint is deleting'); END
  `;

  yield* addThreadRetentionResourceSecurity(sql);
  yield* sql`
    CREATE INDEX idx_worktree_runtime_leases_thread
    ON worktree_runtime_leases(thread_id)
  `;
});
