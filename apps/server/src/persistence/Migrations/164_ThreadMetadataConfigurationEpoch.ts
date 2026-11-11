import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist the active budget epoch independently of process-local settings revisions. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE thread_metadata_configuration_epoch (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    fingerprint TEXT NOT NULL,
    epoch TEXT NOT NULL
  )`;
});
