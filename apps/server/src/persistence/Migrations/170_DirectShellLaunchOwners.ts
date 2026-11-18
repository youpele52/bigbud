import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE direct_shell_launch_owners (
    owner_key TEXT PRIMARY KEY NOT NULL,
    reservation_id TEXT NOT NULL UNIQUE,
    controller_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'may-have-been-sent', 'outcome-unknown')),
    owner_json TEXT NOT NULL
  )`;
});
