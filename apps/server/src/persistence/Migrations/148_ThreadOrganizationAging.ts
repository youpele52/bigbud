import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Disposable, event-derived projection metadata. Captured/restored with projection_threads.
// Runtime policy/completion/receipt state remains outside projection baseline ownership.
// Constant-size schema work only: no conversation JSON scan in the migration transaction.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN organization_activity_at TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN organization_age_provenance TEXT NOT NULL DEFAULT 'pending'
    CHECK (organization_age_provenance IN ('pending', 'known', 'fallback'))`;
  yield* sql`CREATE INDEX idx_projection_threads_age_pending ON projection_threads(thread_id)
    WHERE organization_age_provenance = 'pending' AND organization_revision > 0`;
  // Disposable resumable scan state, reset on restore (never a runtime deadline).
  yield* sql`CREATE TABLE projection_organization_age_backfill (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    after_thread_id TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    event_cursor INTEGER NOT NULL DEFAULT 0,
    observed_revision INTEGER NOT NULL DEFAULT 0,
    anchor TEXT,
    last_changed_at TEXT,
    invalid INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO projection_organization_age_backfill (singleton) VALUES (1)`;
});
