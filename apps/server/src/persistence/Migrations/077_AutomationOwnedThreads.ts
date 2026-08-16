import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE automation_schedules
    ADD COLUMN owns_target_thread INTEGER NOT NULL DEFAULT 0
      CHECK (owns_target_thread IN (0, 1))
  `;
  yield* sql`
    CREATE INDEX idx_automation_schedules_owned_target_thread
    ON automation_schedules(target_thread_id, deleted_at)
    WHERE owns_target_thread = 1 AND deleted_at IS NULL
  `;
});
