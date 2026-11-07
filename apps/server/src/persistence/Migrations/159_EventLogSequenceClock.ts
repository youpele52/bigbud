import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `event_log_sequence_clock`: server-clock samples of the event-log head, written by event-log
 * maintenance at most every 5 minutes and kept for about a day. Every event at or below a
 * sample's `head_sequence` existed at `observed_at_ms`, so the 24-hour hot window can be bounded
 * by the server's clock instead of `occurred_at`, which often comes from a client's clock (see
 * `EventLogMaintenance.sequenceClock`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS event_log_sequence_clock (
      observed_at_ms INTEGER PRIMARY KEY,
      head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0)
    )
  `;
});
