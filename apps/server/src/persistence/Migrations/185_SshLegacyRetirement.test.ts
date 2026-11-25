import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { latestMigrationId, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("adds the legacy retirement record and marker ceiling after 184", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 185 });
    assert.isAtLeast(latestMigrationId, 185);
    assert.deepEqual(yield* sql`SELECT * FROM ssh_legacy_retirement`, []);
    assert.deepEqual(yield* sql`SELECT * FROM ssh_legacy_retired_marker`, []);
    // The marker cannot exist without its record, so both rows share one transaction.
    assert.isTrue(
      yield* Effect.isFailure(sql`
        INSERT INTO ssh_legacy_retired_marker (profile_scope, artifact_id, recorded_at)
        VALUES ('dev', 'build-a', 1)
      `),
    );
    yield* sql`
      INSERT INTO ssh_legacy_retirement
        (profile_scope, artifact_id, decision, drained_leases, pending_items, created_at, updated_at)
      VALUES ('dev', 'build-a', 'drain-now', '[]', '[]', 1, 1)
    `;
    yield* sql`
      INSERT INTO ssh_legacy_retired_marker (profile_scope, artifact_id, recorded_at)
      VALUES ('dev', 'build-a', 1)
    `;
    assert.isTrue(
      yield* Effect.isFailure(sql`
        INSERT INTO ssh_legacy_retirement
          (profile_scope, artifact_id, decision, drained_leases, pending_items,
            created_at, updated_at)
        VALUES ('dev', 'build-b', 'quit', '[]', '[]', 1, 1)
      `),
    );
    yield* runMigrations({ toMigrationInclusive: 185 });
    assert.equal((yield* sql`SELECT * FROM ssh_legacy_retired_marker`).length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
