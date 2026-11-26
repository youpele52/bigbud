import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migration 148 gained `last_changed_at` after some development databases had already applied
// an earlier draft of it. Without the column every organization-age backfill page fails, threads
// stay `pending`, no projection baseline candidate can be created, and canonical cleanup coverage
// never advances. Repair the drifted table; the scan state is disposable, so restart it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_organization_age_backfill)
  `;
  if (columns.length === 0 || columns.some((column) => column.name === "last_changed_at")) return;
  yield* sql`ALTER TABLE projection_organization_age_backfill ADD COLUMN last_changed_at TEXT`;
  yield* sql`UPDATE projection_organization_age_backfill SET
    after_thread_id = '', thread_id = NULL, revision = 0, event_cursor = 0,
    observed_revision = 0, anchor = NULL, invalid = 0, last_changed_at = NULL
    WHERE singleton = 1`;
});
