import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE learning_jobs
    ADD COLUMN memory_user_message_count INTEGER
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_learning_jobs_thread_memory_user_message_count
    ON learning_jobs(thread_id, memory_user_message_count)
  `;
});
