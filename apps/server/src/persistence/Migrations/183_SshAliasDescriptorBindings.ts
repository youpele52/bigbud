import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Preparatory, additive schema for the Rust SSH owner's saved-alias rule. One row records the
// owner-resolved alias descriptor a profile approved for a target. A missing row means no saved
// approval exists yet; it is never inferred from the disconnect or transition tables.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ssh_alias_descriptor_bindings (
      profile_scope TEXT NOT NULL,
      target_id TEXT NOT NULL,
      descriptor_digest TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      PRIMARY KEY (profile_scope, target_id)
    )
  `;
});
