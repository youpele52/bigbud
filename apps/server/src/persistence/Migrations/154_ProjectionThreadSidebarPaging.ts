import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Sidebar pages in displayed order.
 *
 * `projection_threads.latest_user_message_at` was added by migration 021 but never maintained, so
 * every sidebar read recomputed it with a per-thread subquery. This backfills it and keeps it exact
 * with triggers: any write to the column, a new thread row, or a user message insert, delete or
 * move recomputes `MAX(created_at)` through `idx_projection_thread_messages_latest_user` (one index
 * seek). Baseline restores that upsert an older value are corrected the same way.
 *
 * The partial indexes serve keyset pages by `(sortKey DESC, thread_id DESC)`, where the sort key is
 * the latest user message (falling back to creation) or creation time, matching the client sort.
 */
const LATEST_USER_MESSAGE_SQL = (threadIdExpression: string) => `(
  SELECT MAX(m.created_at)
  FROM projection_thread_messages m
  WHERE m.thread_id = ${threadIdExpression} AND m.role = 'user'
)`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    UPDATE projection_threads
    SET latest_user_message_at = ${LATEST_USER_MESSAGE_SQL("projection_threads.thread_id")}
  `);

  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_latest_user_message_insert
    AFTER INSERT ON projection_thread_messages WHEN new.role = 'user' BEGIN
      UPDATE projection_threads
      SET latest_user_message_at = ${LATEST_USER_MESSAGE_SQL("new.thread_id")}
      WHERE thread_id = new.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_latest_user_message_delete
    AFTER DELETE ON projection_thread_messages WHEN old.role = 'user' BEGIN
      UPDATE projection_threads
      SET latest_user_message_at = ${LATEST_USER_MESSAGE_SQL("old.thread_id")}
      WHERE thread_id = old.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_latest_user_message_update
    AFTER UPDATE OF role, created_at, thread_id ON projection_thread_messages
    WHEN old.role = 'user' OR new.role = 'user' BEGIN
      UPDATE projection_threads
      SET latest_user_message_at = ${LATEST_USER_MESSAGE_SQL("projection_threads.thread_id")}
      WHERE thread_id IN (old.thread_id, new.thread_id);
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_latest_user_message_thread_insert
    AFTER INSERT ON projection_threads BEGIN
      UPDATE projection_threads
      SET latest_user_message_at = ${LATEST_USER_MESSAGE_SQL("new.thread_id")}
      WHERE thread_id = new.thread_id;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER IF NOT EXISTS projection_threads_latest_user_message_correct
    AFTER UPDATE OF latest_user_message_at ON projection_threads
    WHEN new.latest_user_message_at IS NOT ${LATEST_USER_MESSAGE_SQL("new.thread_id")} BEGIN
      UPDATE projection_threads
      SET latest_user_message_at = ${LATEST_USER_MESSAGE_SQL("new.thread_id")}
      WHERE thread_id = new.thread_id;
    END
  `);

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_activity_page
    ON projection_threads(
      project_id,
      COALESCE(latest_user_message_at, created_at) DESC,
      thread_id DESC
    )
    WHERE purpose = 'standard'
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND deleting_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_created_page
    ON projection_threads(project_id, created_at DESC, thread_id DESC)
    WHERE purpose = 'standard'
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND deleting_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_organization_activity_page
    ON projection_threads(
      organization_state,
      COALESCE(latest_user_message_at, created_at) DESC,
      thread_id DESC
    )
    WHERE purpose = 'standard'
      AND deleted_at IS NULL
      AND archived_at IS NULL
      AND deleting_at IS NULL
  `;
});
