import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Serves Ìtútù snooze delivery: pending snoozes in deadline order. Only snoozed threads are
 * indexed, so startup recovery and the periodic sweep never scan the whole thread table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_pending_snooze
    ON projection_threads(organization_snooze_until ASC, thread_id ASC)
    WHERE organization_snooze_id IS NOT NULL
  `;
});
