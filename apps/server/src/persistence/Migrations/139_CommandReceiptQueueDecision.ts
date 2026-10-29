import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Additive metadata avoids rebuilding the potentially large receipt table or changing old claims. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN queue_decision_reason TEXT`;
});
