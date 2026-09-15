import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { rebuildTableSql } from "./MigrationTableRebuild.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Migration 118 missed installed schemas whose CHECK only allowed computer-use.
  // Rebuild from the canonical definition instead of matching historical SQL text.
  yield* rebuildTableSql(
    sql,
    "thread_activity_leases",
    () => `CREATE TABLE thread_activity_leases (
      lease_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
      activity_kind TEXT NOT NULL CHECK (activity_kind IN ('browser', 'computer-use', 'learning')),
      acquired_at TEXT NOT NULL
    )`,
  );
});
