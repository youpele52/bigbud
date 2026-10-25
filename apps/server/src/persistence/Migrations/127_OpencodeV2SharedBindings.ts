import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No FK/cascade: absence of a runtime cursor cannot license another native creation.
  yield* sql`CREATE TABLE opencode_v2_shared_bindings (
    thread_id TEXT PRIMARY KEY NOT NULL,
    material_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved', 'dispatch-intent', 'verified')),
    revision INTEGER NOT NULL CHECK(revision >= 0)
  )`;
});
