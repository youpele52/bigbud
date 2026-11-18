import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Completed purge jobs survive removal of canonical identities and projections.
 * Project purges create individual thread jobs too. Keep every recorded thread ID
 * in the prior cohort so recreating an erased ID cannot bypass historical claims.
 * This is additive for installations that already applied migration 171.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO thread_metadata_legacy_prior_threads (thread_id)
    SELECT entity_id FROM purge_jobs WHERE entity_kind = 'thread'`;
});
