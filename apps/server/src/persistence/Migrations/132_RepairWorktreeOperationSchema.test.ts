import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { rebuildTableSql } from "./MigrationTableRebuild.ts";
import repair from "./132_RepairWorktreeOperationSchema.ts";

const children = [
  "worktree_operation_items",
  "worktree_provider_relocations",
  "worktree_provider_lineage",
];

const legacy = Effect.fn("legacyWorktreeOperationSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 131 });
  yield* sql.withTransaction(
    rebuildTableSql(
      sql,
      "worktree_operations",
      (ddl) => ddl.replace("'rename', 'delete', 'create', 'access'", "'rename', 'delete'"),
      { children },
    ),
  );
  for (const column of ["parent_path", "parent_device", "parent_inode"]) {
    yield* sql.unsafe(`ALTER TABLE worktree_operations DROP COLUMN ${column}`);
  }
  const guards = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'worktree_operation_%'`;
  for (const guard of guards) {
    if (
      ![
        "worktree_operation_runtime_insert",
        "worktree_operation_runtime_update",
        "worktree_operation_cleanup_insert",
      ].includes(guard.name)
    ) {
      yield* sql.unsafe(`DROP TRIGGER ${guard.name}`);
    }
  }
  yield* sql`INSERT INTO worktree_operations (
    operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
    canonical_path, device, inode, branch, head, phase, created_at
  ) VALUES ('pending', 'digest', 'rename', '/repo/.git', '/repo', '/old', '/new', '/old',
    1, 2, 'branch', 'head', 'prepared', 'now')`;
  yield* sql`INSERT INTO worktree_operation_items VALUES ('pending','thread','/old','/new','command',0)`;
});

it.effect(
  "repairs an already-applied schema before startup recovery, retaining pending intents",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacy();
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(sql`SELECT parent_path FROM worktree_operations`)),
      );
      assert.deepEqual(
        (yield* runMigrations()).filter(([id]) => id === 132),
        [[132, "RepairWorktreeOperationSchema"]],
      );
      const rows =
        yield* sql`SELECT operation_id, parent_path, parent_device, parent_inode, phase FROM worktree_operations`;
      assert.deepEqual(rows, [
        {
          operation_id: "pending",
          parent_path: null,
          parent_device: null,
          parent_inode: null,
          phase: "recovery-required",
        },
      ]);
      assert.equal((yield* sql`SELECT * FROM worktree_operation_items`).length, 1);
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'worktree_operation_%'`).length,
        11,
      );
      for (const kind of ["create", "access"]) {
        yield* sql`INSERT INTO worktree_operations (
        operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
        canonical_path, device, inode, phase, created_at
      ) VALUES (${kind}, 'digest', ${kind}, '/other/.git', '/other', '/else', '/else', '/else',
        3, 4, 'completed', 'now')`;
      }
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("leaves modern operation data unchanged on migration and repeated repair", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 131 });
    yield* sql`INSERT INTO worktree_operations (
      operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
      canonical_path, device, inode, parent_path, parent_device, parent_inode, phase, created_at
    ) VALUES ('modern','digest','access','/repo/.git','/repo','/repo','/repo','/repo',1,2,'/',1,3,'completed','now')`;
    const before = yield* sql`SELECT * FROM worktree_operations`;
    yield* runMigrations();
    yield* sql.withTransaction(repair);
    assert.deepEqual(yield* sql`SELECT * FROM worktree_operations`, before);
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back schema repair and retries without losing the original operation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* legacy();
    const before = yield* sql`SELECT * FROM worktree_operations`;
    const schema = yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`;
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          sql.withTransaction(repair.pipe(Effect.andThen(Effect.fail(new Error("interrupted"))))),
        ),
      ),
    );
    assert.deepEqual(yield* sql`SELECT * FROM worktree_operations`, before);
    assert.deepEqual(yield* sql`SELECT name,sql FROM sqlite_master ORDER BY name`, schema);
    yield* runMigrations();
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("preserves completed native relocation evidence while rebuilding its parent table", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* legacy();
    yield* sql`UPDATE worktree_operations SET phase = 'moved' WHERE operation_id = 'pending'`;
    yield* sql`INSERT INTO worktree_provider_relocations (
      plan_digest, operation_id, thread_id, provider, plan_json, phase
    ) VALUES ('plan','pending','thread','codex',
      '{"request":{"sourceCwd":"/old","destinationCwd":"/new"}}','verified')`;
    yield* sql`INSERT INTO worktree_provider_lineage VALUES ('plan','pending','thread','/old','/new','now')`;
    yield* sql`UPDATE worktree_operations SET phase = 'completed' WHERE operation_id = 'pending'`;
    const intents = yield* sql`SELECT * FROM worktree_provider_relocations`;
    const lineage = yield* sql`SELECT * FROM worktree_provider_lineage`;
    yield* runMigrations();
    assert.deepEqual(yield* sql`SELECT * FROM worktree_provider_relocations`, intents);
    assert.deepEqual(yield* sql`SELECT * FROM worktree_provider_lineage`, lineage);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(sql`DELETE FROM worktree_provider_lineage`)));
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(sql`UPDATE worktree_provider_relocations SET plan_json = '{}'`),
      ),
    );
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
