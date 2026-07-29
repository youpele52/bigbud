import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Provider selection inventory is intentionally empty on creation. It is a
 * compatibility surface for future provider removals, not a destructive
 * backfill. Existing selections and runtime rows remain untouched until the
 * application can classify them against its current provider registry.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_selection_inventory (
      inventory_id TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      source TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      selection_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      reason TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE (owner_kind, owner_id, source)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_selection_inventory_provider_status
    ON provider_selection_inventory(provider, status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_selection_quarantine (
      quarantine_id TEXT PRIMARY KEY,
      inventory_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      source TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      selection_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      quarantined_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_selection_quarantine_owner
    ON provider_selection_quarantine(owner_kind, owner_id, source)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_selection_quarantine_provider
    ON provider_selection_quarantine(provider, resolved_at)
  `;
});
