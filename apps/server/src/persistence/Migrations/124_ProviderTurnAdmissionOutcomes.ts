import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE provider_turn_admissions ADD COLUMN terminal_outcome TEXT
    CHECK(terminal_outcome IS NULL OR terminal_outcome IN ('completed', 'failed', 'interrupted'))`;
  yield* sql`CREATE INDEX provider_turn_admissions_bound_latest ON provider_turn_admissions
    (CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END,
     created_at DESC, updated_at DESC, request_message_id DESC)`;
});
