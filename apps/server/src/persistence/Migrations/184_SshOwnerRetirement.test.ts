import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { latestMigrationId, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const columns = (sql: SqlClient.SqlClient) =>
  sql<{ name: string }>`SELECT name FROM pragma_table_info('ssh_owner_retirement') ORDER BY cid`;

it.effect("adds the retirement mirror to the Build A ceiling on a fresh database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 184 });
    assert.isAtLeast(latestMigrationId, 184);
    assert.deepEqual(
      (yield* columns(sql)).map((row) => row.name),
      [
        "profile_scope",
        "target_id",
        "owner_epoch",
        "generation",
        "state",
        "pid",
        "start_time",
        "namespace",
        "detail",
        "updated_at",
      ],
    );
    assert.deepEqual(yield* sql`SELECT * FROM ssh_owner_retirement`, []);
    yield* sql`
      INSERT INTO ssh_owner_retirement
        (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
          detail, updated_at)
      VALUES ('dev', 'ssh:one', '', '', 'intent', NULL, NULL, NULL, 'before spawn', 1)
    `;
    yield* sql`
      INSERT INTO ssh_owner_retirement
        (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
          detail, updated_at)
      VALUES ('dev', 'ssh:two', 'ab', 'cd', 'bound', 42, '100', NULL, 'bound', 2)
    `;
    // An intent carries no process identity.
    assert.isTrue(
      yield* Effect.isFailure(sql`
        INSERT INTO ssh_owner_retirement
          (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
            detail, updated_at)
        VALUES ('dev', 'ssh:bad', '', '', 'intent', 42, '100', NULL, 'bad', 3)
      `),
    );
    // A bound row requires an epoch, generation, PID and start time.
    assert.isTrue(
      yield* Effect.isFailure(sql`
        INSERT INTO ssh_owner_retirement
          (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
            detail, updated_at)
        VALUES ('dev', 'ssh:bad', '', 'cd', 'bound', 42, '100', NULL, 'bad', 3)
      `),
    );
    assert.deepEqual(yield* sql`SELECT target_id FROM ssh_owner_retirement ORDER BY target_id`, [
      { target_id: "ssh:one" },
      { target_id: "ssh:two" },
    ]);
    // Re-running the additive migration is safe and preserves rows.
    yield* runMigrations({ toMigrationInclusive: 184 });
    assert.equal((yield* sql`SELECT * FROM ssh_owner_retirement`).length, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
