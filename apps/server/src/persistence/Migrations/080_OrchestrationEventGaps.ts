import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_event_gaps (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `;
});
