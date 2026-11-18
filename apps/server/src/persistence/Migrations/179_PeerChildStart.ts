import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * P8 worker child start intent (F-P8-3). `start_json` is the durable intent to create the child
 * thread and start its first turn, recorded with the `peer_children` claim, so the worker completes
 * it on its own (request fiber or reconciler) with the same command ids even when the peer channel
 * dies between the steps. `start_completed_at` marks both commands accepted; `start_failure` holds
 * the reason when the worker definitively could not start the child.
 *
 * Rows from before this migration keep `start_json` NULL and are reported as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('peer_children')`;
  const has = new Set(columns.map((column) => column.name));
  if (!has.has("start_json")) yield* sql`ALTER TABLE peer_children ADD COLUMN start_json TEXT`;
  if (!has.has("start_completed_at"))
    yield* sql`ALTER TABLE peer_children ADD COLUMN start_completed_at TEXT`;
  if (!has.has("start_failure"))
    yield* sql`ALTER TABLE peer_children ADD COLUMN start_failure TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS peer_children_incomplete_start
    ON peer_children(created_at)
    WHERE start_json IS NOT NULL AND start_completed_at IS NULL AND start_failure IS NULL`;
});
