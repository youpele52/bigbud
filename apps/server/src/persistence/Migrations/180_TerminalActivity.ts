import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Terminal recency and finished terminal work (terminal activity plan, 19 November 2026).
 *
 * `latest_terminal_activity_at` is the last Enter or finished command in any of a thread's
 * terminals, written at most once a minute per thread. It joins the display sort key, so the
 * migration 154 activity page indexes are replaced by indexes on the new key; the expression
 * must match `THREAD_RECENCY_SORT_KEY_SQL` character for character so SQLite walks the index.
 *
 * `terminal_finished_attention` holds one finished item per pane that needs the user. It is an
 * organiser attention source (like pending approvals) and survives restarts.
 */
export const THREAD_RECENCY_INDEX_EXPRESSION = `MAX(
      COALESCE(latest_user_message_at, created_at),
      COALESCE(latest_terminal_activity_at, created_at)
    )`;

const LIVE_STANDARD_PREDICATE = `purpose = 'standard'
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND deleting_at IS NULL`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('projection_threads')`;
  if (!columns.some((column) => column.name === "latest_terminal_activity_at"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_terminal_activity_at TEXT`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS terminal_finished_attention (
      thread_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      command TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      source TEXT NOT NULL,
      PRIMARY KEY (thread_id, terminal_id)
    )
  `;

  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_project_activity_page`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_threads_organization_activity_page`;
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_recency_page
    ON projection_threads(project_id, ${THREAD_RECENCY_INDEX_EXPRESSION} DESC, thread_id DESC)
    WHERE ${LIVE_STANDARD_PREDICATE}
  `);
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_organization_recency_page
    ON projection_threads(organization_state, ${THREAD_RECENCY_INDEX_EXPRESSION} DESC, thread_id DESC)
    WHERE ${LIVE_STANDARD_PREDICATE}
  `);
});
