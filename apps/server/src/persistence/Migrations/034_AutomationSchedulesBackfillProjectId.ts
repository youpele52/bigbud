import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE automation_schedules
    SET project_id = (
      SELECT projection_threads.project_id
      FROM projection_threads
      WHERE projection_threads.thread_id = automation_schedules.target_thread_id
      LIMIT 1
    )
    WHERE project_id IS NULL
  `;
});
