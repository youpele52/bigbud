import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Swallows only "duplicate column" errors; re-raises everything else. */
const ignoreDuplicateColumn = (err: SqlError) =>
  /duplicate column/i.test(String(err.cause)) ? Effect.void : Effect.fail(err);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_id TEXT
  `.pipe(Effect.catchTag("SqlError", ignoreDuplicateColumn));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_title TEXT
  `.pipe(Effect.catchTag("SqlError", ignoreDuplicateColumn));
});
