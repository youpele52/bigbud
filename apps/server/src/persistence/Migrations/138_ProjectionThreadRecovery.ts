import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The thread's visible sleep and wake recovery notice. Nullable, no backfill. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "recovery_json")) {
    yield* sql`ALTER TABLE projection_threads
      ADD COLUMN recovery_json TEXT`;
  }
});
