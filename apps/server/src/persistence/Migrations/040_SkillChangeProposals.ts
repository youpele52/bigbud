import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_change_proposals (
      proposal_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      skill_path TEXT NOT NULL,
      original_hash TEXT NOT NULL,
      old_text TEXT NOT NULL,
      new_text TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_skill_change_proposals_thread_status
    ON skill_change_proposals(thread_id, status, created_at)
  `;
});
