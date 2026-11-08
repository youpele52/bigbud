import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'external'`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN previous_workspace_root TEXT`;
});
