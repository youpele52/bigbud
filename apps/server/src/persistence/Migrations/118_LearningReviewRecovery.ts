import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { rebuildTableSql } from "./MigrationTableRebuild.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE learning_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE learning_jobs ADD COLUMN next_attempt_at TEXT`;
  yield* sql`ALTER TABLE learning_jobs ADD COLUMN outcome TEXT`;
  yield* sql`CREATE INDEX idx_learning_jobs_due ON learning_jobs(state, next_attempt_at, created_at)`;
  yield* rebuildTableSql(sql, "thread_activity_leases", (ddl) =>
    ddl.replace("'browser', 'computer-use'", "'browser', 'computer-use', 'learning'"),
  );
});
