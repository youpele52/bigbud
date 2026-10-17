import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE provider_turn_admissions ADD COLUMN final_text_encoding TEXT NOT NULL DEFAULT 'plain'
    CHECK(final_text_encoding IN ('plain', 'gzip'))`;
  yield* sql`CREATE INDEX provider_turn_admissions_bound_scan ON provider_turn_admissions
    (CASE WHEN json_valid(binding_json) THEN json_extract(binding_json, '$.threadId') END,
     created_at, namespace, owner_thread_id, request_message_id)`;
});
