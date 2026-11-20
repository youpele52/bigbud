import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Historical cancellations cannot prove that they never crossed the dispatch fence. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_metadata_generation_attempts
    ADD COLUMN cancelled_before_dispatch_at_deadline INTEGER NOT NULL DEFAULT 0
    CHECK(cancelled_before_dispatch_at_deadline IN (0, 1))`;
});
