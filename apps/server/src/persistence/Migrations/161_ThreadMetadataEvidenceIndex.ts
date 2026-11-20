import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Activity sequence is optional provider data, not the canonical event sequence.
  // Recover the latter by exact identity without repeatedly scanning a thread's event history.
  yield* sql`CREATE INDEX idx_orch_events_thread_activity_identity
    ON orchestration_events (
      stream_id,
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.activity.id') END,
      sequence DESC
    ) WHERE aggregate_kind = 'thread' AND event_type = 'thread.activity-appended'`;
});
