import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN rejection_reason TEXT CHECK (
      rejection_reason IS NULL OR rejection_reason IN ('thread_already_exists', 'other')
    )
  `;
});
