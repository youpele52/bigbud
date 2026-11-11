import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Existing warnings represent three failures; new unavailable warnings retain the actual count. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_metadata_generation_warnings
    ADD COLUMN primary_failures INTEGER NOT NULL DEFAULT 3
    CHECK(primary_failures BETWEEN 0 AND 3)`;
});
