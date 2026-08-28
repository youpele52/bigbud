import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_thread_identity
    SET created_sequence = COALESCE((
      SELECT MAX(event.sequence)
      FROM orchestration_events AS event
      WHERE event.aggregate_kind = 'thread'
        AND event.stream_id = orchestration_thread_identity.thread_id
        AND event.event_type = 'thread.created'
    ), created_sequence),
    project_id = COALESCE((
      SELECT json_extract(event.payload_json, '$.projectId')
      FROM orchestration_events AS event
      WHERE event.aggregate_kind = 'thread'
        AND event.stream_id = orchestration_thread_identity.thread_id
        AND event.event_type = 'thread.created'
      ORDER BY event.sequence DESC
      LIMIT 1
    ), project_id)
  `;
});
