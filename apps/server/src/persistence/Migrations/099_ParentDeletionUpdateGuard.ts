import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { threadRetentionUnavailableEndpoint } from "./063_ThreadRetentionResourceSecurity.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_parent_insert`;
  yield* sql`DROP TRIGGER IF EXISTS thread_retention_guard_parent_update`;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_parent_insert
    BEFORE INSERT ON projection_threads
    WHEN NEW.parent_thread_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM projection_threads AS current
        WHERE current.thread_id = NEW.thread_id
          AND current.parent_thread_id IS NEW.parent_thread_id
      )
      AND ${threadRetentionUnavailableEndpoint(sql, "parent_thread_id")}
    BEGIN SELECT RAISE(ABORT, 'parent thread is deleting'); END
  `;
  yield* sql`
    CREATE TRIGGER thread_retention_guard_parent_update
    BEFORE UPDATE OF parent_thread_id ON projection_threads
    WHEN NEW.parent_thread_id IS NOT OLD.parent_thread_id
      AND NEW.parent_thread_id IS NOT NULL
      AND ${threadRetentionUnavailableEndpoint(sql, "parent_thread_id")}
    BEGIN SELECT RAISE(ABORT, 'parent thread is deleting'); END
  `;
});
