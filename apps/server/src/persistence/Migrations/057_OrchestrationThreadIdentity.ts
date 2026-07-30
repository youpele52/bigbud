import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_thread_identity (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_sequence INTEGER NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
    SELECT stream_id, json_extract(payload_json, '$.projectId'), sequence
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.created'
      AND json_extract(payload_json, '$.projectId') IS NOT NULL
    ON CONFLICT (thread_id) DO NOTHING
  `;
});
