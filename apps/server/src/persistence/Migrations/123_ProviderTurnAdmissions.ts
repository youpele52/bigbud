import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No cascading FK: removing a thread/runtime binding cannot license replay.
  yield* sql`CREATE TABLE provider_turn_admissions (
    namespace TEXT NOT NULL CHECK(namespace IN ('foreground', 'learning')),
    owner_thread_id TEXT NOT NULL,
    request_message_id TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    native_admission_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved', 'dispatch-intent', 'accepted', 'terminal')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    final_text TEXT,
    PRIMARY KEY(namespace, owner_thread_id, request_message_id)
  )`;
  yield* sql`CREATE INDEX provider_turn_admissions_unresolved
    ON provider_turn_admissions(state, updated_at, namespace, owner_thread_id, request_message_id)`;
});
