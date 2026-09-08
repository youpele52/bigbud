import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN payload_digest_version TEXT
  `;

  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN payload_digest TEXT
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_command_receipt_claims (
      command_id TEXT PRIMARY KEY,
      payload_digest_version TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    )
  `;
});
