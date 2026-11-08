import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Each run records why the selector skipped threads older than its cutoff, so a run that
// deletes nothing can say why. NULL means the run predates this column or was never selected.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE thread_retention_runs ADD COLUMN exclusion_counts_json TEXT`;
});
