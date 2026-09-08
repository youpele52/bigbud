import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const insertLease = Effect.fn("test.insertRuntimeLease")(function* (
  leaseId: string,
  runtimeKind: "terminal" | "shell" | "provider",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO worktree_runtime_leases
    (lease_id, thread_id, runtime_kind, canonical_path, device, inode, acquired_at, updated_at)
    VALUES (${leaseId}, 'lease-thread', ${runtimeKind}, '/tmp/project', 1, 2, 'now', 'now')`;
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "102_ThreadRuntimeLeaseTerminalMultiplicity",
  (it) => {
    it.effect("preserves the pre-102 schema while allowing terminal multiplicity", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 101 });
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES ('lease-thread', 'project', 'Lease thread', '{}', 'full-access', 'default', 'now', 'now')`;
        yield* insertLease("terminal:existing", "terminal");
        yield* insertLease("shell:existing", "shell");
        yield* insertLease("provider:existing", "provider");

        yield* runMigrations();

        assert.deepEqual(
          yield* sql`SELECT lease_id, runtime_kind FROM worktree_runtime_leases ORDER BY lease_id`,
          [
            { lease_id: "provider:existing", runtime_kind: "provider" },
            { lease_id: "shell:existing", runtime_kind: "shell" },
            { lease_id: "terminal:existing", runtime_kind: "terminal" },
          ],
        );
        yield* insertLease("terminal:second", "terminal");
        assert.equal((yield* Effect.exit(insertLease("shell:second", "shell")))._tag, "Failure");
        assert.equal(
          (yield* Effect.exit(insertLease("provider:second", "provider")))._tag,
          "Failure",
        );
        assert.deepEqual(
          yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
            WHERE type = 'index' AND name IN (
              'idx_worktree_runtime_leases_identity',
              'idx_worktree_runtime_leases_runtime_identity',
              'idx_worktree_runtime_leases_thread'
            ) ORDER BY name`,
          [
            { name: "idx_worktree_runtime_leases_identity" },
            { name: "idx_worktree_runtime_leases_runtime_identity" },
            { name: "idx_worktree_runtime_leases_thread" },
          ],
        );
        assert.deepEqual(
          yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name IN (
              'thread_retention_guard_runtime_lease_insert',
              'thread_retention_guard_runtime_lease_update'
            ) ORDER BY name`,
          [
            { name: "thread_retention_guard_runtime_lease_insert" },
            { name: "thread_retention_guard_runtime_lease_update" },
          ],
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        assert.deepEqual(
          yield* sql`SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'worktree_runtime_leases_next'`,
          [],
        );
        assert.deepEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 102`,
          [{ migration_id: 102, name: "ThreadRuntimeLeaseTerminalMultiplicity" }],
        );
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "102_ThreadRuntimeLeaseTerminalMultiplicity transaction",
  (it) => {
    it.effect("rolls back the table replacement when artifact recreation fails", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 101 });
        yield* sql`INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES ('lease-thread', 'project', 'Lease thread', '{}', 'full-access', 'default', 'now', 'now')`;
        yield* insertLease("terminal:existing", "terminal");
        yield* sql`CREATE INDEX idx_worktree_runtime_leases_runtime_identity
          ON worktree_runtime_leases(process_id)`;

        assert.equal((yield* Effect.exit(runMigrations()))._tag, "Failure");
        assert.deepEqual(yield* sql`SELECT lease_id FROM worktree_runtime_leases`, [
          { lease_id: "terminal:existing" },
        ]);
        assert.equal(
          (yield* Effect.exit(insertLease("terminal:second", "terminal")))._tag,
          "Failure",
        );
        assert.deepEqual(
          yield* sql`SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_worktree_runtime_leases_runtime_identity'`,
          [{ name: "idx_worktree_runtime_leases_runtime_identity" }],
        );
        assert.deepEqual(
          yield* sql`SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'worktree_runtime_leases_next'`,
          [],
        );
        assert.deepEqual(
          yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 102`,
          [],
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }),
    );
  },
);
