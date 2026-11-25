import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Build A schema ceiling for owner-death retirement. These rows mirror the
// owner's private retirement journal; the journal is authoritative for
// admission. `intent` precedes a spawn, `bound` records the owner epoch and
// generation (the journal holds the authoritative PID/start/namespace), and
// `retired` is only written after verified absence/reap.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ssh_owner_retirement (
      profile_scope TEXT NOT NULL,
      target_id TEXT NOT NULL,
      owner_epoch TEXT NOT NULL,
      generation TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('intent', 'bound', 'retired')),
      pid INTEGER,
      start_time TEXT,
      namespace TEXT,
      detail TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (profile_scope, target_id),
      CHECK (
        (state = 'intent' AND owner_epoch = '' AND generation = ''
          AND pid IS NULL AND start_time IS NULL AND namespace IS NULL)
        OR (state = 'bound' AND owner_epoch <> '' AND generation <> '')
        OR (state = 'retired')
      )
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS ssh_owner_retirement_unresolved
    ON ssh_owner_retirement (profile_scope, state)
  `;
});
