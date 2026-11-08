import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A snooze reminder is actionable even when an unrelated job keeps running. Explicit manual
// organisation or a human response dismisses this reminder, never a real pending request.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_organization_runtime_threads ADD COLUMN needs_attention_reminder INTEGER NOT NULL DEFAULT 0
    CHECK (needs_attention_reminder IN (0, 1))`;
});
