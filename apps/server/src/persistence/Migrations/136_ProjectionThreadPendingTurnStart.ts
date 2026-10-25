import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable gate for a requested turn the provider has not bound yet. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "pending_turn_start_json")) {
    yield* sql`ALTER TABLE projection_threads
      ADD COLUMN pending_turn_start_json TEXT`;
  }
});
