import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { rehashVerifiedBaselinesWithoutTurnRowIds } from "./158_EventLogMaintenanceOrphanClaims.baselines.ts";

/**
 * Orphan-claim pruning state on `event_log_maintenance_state` (event-log maintenance prunes
 * command-receipt claims whose receipt is gone in repeated bounded passes):
 *
 * - `orphan_claims_through_rowid`: every claim at or below this rowid was examined in the
 *   current pass, so a restart resumes there instead of rescanning the table.
 * - `orphan_claims_pass_at`: when the last pass finished; the next one starts a day later,
 *   because other deletion paths can still orphan claims below the cursor.
 *
 * Also in this release:
 *
 * - `thread_branch_copies`: durable progress of server-side branch copies. The branch point
 *   (`boundary_*`) is fixed when the branch is requested; `cursor_*` is the last source message
 *   copied, and `next_batch` names the next batch command, so a restart resumes there.
 * - Attachment-hold lookups by `relative_path` in the deletion pipelines, which scanned both
 *   tables whole.
 * - Projection baselines without `projection_turns.row_id`: stored turn rows lose it and every
 *   verified baseline is rehashed (see `rehashVerifiedBaselinesWithoutTurnRowIds`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE event_log_maintenance_state
    ADD COLUMN orphan_claims_through_rowid INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`ALTER TABLE event_log_maintenance_state ADD COLUMN orphan_claims_pass_at TEXT`;
  yield* sql`
    CREATE TABLE thread_branch_copies (
      branch_thread_id TEXT PRIMARY KEY,
      source_thread_id TEXT NOT NULL,
      create_input_json TEXT NOT NULL,
      boundary_created_at TEXT NOT NULL,
      boundary_message_id TEXT NOT NULL,
      total_messages INTEGER NOT NULL CHECK (total_messages >= 0),
      copied_messages INTEGER NOT NULL DEFAULT 0 CHECK (copied_messages >= 0),
      next_batch INTEGER NOT NULL DEFAULT 0 CHECK (next_batch >= 0),
      cursor_created_at TEXT,
      cursor_message_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('copying', 'completed', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_thread_branch_copies_copying
    ON thread_branch_copies(created_at) WHERE state = 'copying'
  `;
  yield* sql`
    CREATE INDEX idx_direct_resource_cleanup_resources_live_path
    ON direct_resource_cleanup_resources(resource_kind, relative_path)
    WHERE terminal_at IS NULL
  `;
  yield* sql`
    CREATE INDEX idx_purge_resource_claims_kind_path
    ON purge_resource_claims(resource_kind, relative_path)
  `;
  yield* rehashVerifiedBaselinesWithoutTurnRowIds(sql);
});
