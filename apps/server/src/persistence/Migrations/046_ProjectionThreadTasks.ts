import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable task rows are independent of activity retention and support cold reconstruction. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_tasks (
      task_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      task_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_tasks_thread_order
    ON projection_thread_tasks(thread_id, created_at, task_id)
  `;
  /* Guarded compatibility backfill: only valid task.updated activity payloads are copied. */
  yield* sql`
    INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
    SELECT
      json_extract(activity.payload_json, '$.task.id'),
      activity.thread_id,
      json_set(
        json_extract(activity.payload_json, '$.task'),
        '$.source', COALESCE(json_extract(activity.payload_json, '$.task.source'), 'lifecycle'),
        '$.freshness', COALESCE(
          json_extract(activity.payload_json, '$.task.freshness'),
          json_object('sessionEpoch', 'legacy', 'sourcePriority', 0, 'observedOrdinal', 0)
        )
      ),
      COALESCE(json_extract(activity.payload_json, '$.task.createdAt'), activity.created_at),
      COALESCE(json_extract(activity.payload_json, '$.task.updatedAt'), activity.created_at)
    FROM projection_thread_activities AS activity
    WHERE activity.kind = 'task.updated'
      AND json_type(activity.payload_json, '$.task') = 'object'
      AND json_type(activity.payload_json, '$.task.id') = 'text'
      AND NOT EXISTS (
        SELECT 1 FROM projection_thread_tasks AS existing
        WHERE existing.task_id = json_extract(activity.payload_json, '$.task.id')
      )
  `;
});
