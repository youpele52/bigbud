import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 147 });
  return sql;
});

it.effect(
  "registered 145→146→147 upgrade preserves workspace and organization state exactly once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 145 });
      const workspaceColumns = yield* sql`PRAGMA table_info(projection_projects)`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 146 }), [
        [146, "ThreadOrganizationRuntime"],
      ]);
      const organizationState = yield* sql`SELECT * FROM thread_organization_runtime`;
      const organizationSchema = yield* sql`SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'thread_organization_runtime%' ORDER BY name`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 147 }), [
        [147, "ProjectWorkspaceNativeTransitions"],
      ]);
      assert.deepEqual(yield* sql`PRAGMA table_info(projection_projects)`, workspaceColumns);
      assert.deepEqual(yield* sql`SELECT * FROM thread_organization_runtime`, organizationState);
      assert.deepEqual(
        yield* sql`SELECT type, name, sql FROM sqlite_master
        WHERE name LIKE 'thread_organization_runtime%' ORDER BY name`,
        organizationSchema,
      );
      yield* reserve("upgrade", "command-upgrade");
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 147 }), []);
      assert.deepEqual(yield* sql`SELECT command_id FROM project_workspace_native_operations`, [
        { command_id: "command-upgrade" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

function reserve(operationId: string, commandId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO worktree_operations
      (operation_id, request_digest, kind, repository, cwd, source_path, destination_path,
       canonical_path, device, inode, branch, phase, created_at)
      VALUES (${operationId}, ${commandId}, 'access', '/old', '/old', '/old', '/new',
        '/old', 1, 2, 'workspace-mutation', 'prepared', '2026-11-05')`;
    yield* sql`INSERT INTO project_workspace_native_operations
      (operation_id, command_id, project_id, request_json, source_path, destination_path,
       phase, steps_json, created_at, updated_at)
      VALUES (${operationId}, ${commandId}, 'project', '{}', '/old', '/new',
        'prepared', '[]', '2026-11-05', '2026-11-05')`;
  });
}

it.effect(
  "candidate native migration serializes project transitions and preserves uncertain ownership",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* reserve("first", "command-first");
      assert.isTrue((yield* Effect.result(reserve("second", "command-second")))._tag === "Failure");
      yield* sql`UPDATE project_workspace_native_operations SET phase = 'recovery-required' WHERE operation_id = 'first'`;
      assert.isTrue((yield* Effect.result(reserve("third", "command-third")))._tag === "Failure");
      yield* sql`UPDATE project_workspace_native_operations SET phase = 'committed' WHERE operation_id = 'first'`;
      yield* reserve("fourth", "command-fourth");
      const rows =
        yield* sql`SELECT operation_id FROM project_workspace_native_operations ORDER BY operation_id`;
      assert.deepEqual(rows, [{ operation_id: "first" }, { operation_id: "fourth" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("candidate native migration makes archives and verified Location lineage immutable", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* reserve("first", "command-first");
    yield* sql`INSERT INTO provider_workspace_binding_archives
      (archive_id, operation_id, thread_id, provider, native_session_id, workspace_root, recovery_json, created_at)
      VALUES ('archive', 'first', 'thread', 'muse', 'native-old', '/old', '{"retained":true}', '2026-11-05')`;
    yield* sql`INSERT INTO provider_workspace_archived_admissions
      (archive_id, namespace, owner_thread_id, request_message_id)
      VALUES ('archive', 'namespace', 'thread', 'message')`;
    yield* sql`INSERT INTO provider_workspace_location_lineage
      (operation_id, thread_id, provider, native_session_id, storage_identity, old_location, new_location, verified_at)
      VALUES ('first', 'thread', 'opencodeV2', 'native-v2', 'storage', '/old', '/new', '2026-11-05')`;
    for (const table of [
      "provider_workspace_binding_archives",
      "provider_workspace_archived_admissions",
      "provider_workspace_location_lineage",
    ]) {
      assert.isTrue((yield* Effect.result(sql.unsafe(`DELETE FROM ${table}`)))._tag === "Failure");
    }
    assert.isTrue(
      (yield* Effect.result(
        sql`UPDATE provider_workspace_binding_archives SET recovery_json = '{}'`,
      ))._tag === "Failure",
    );
    assert.isTrue(
      (yield* Effect.result(
        sql`UPDATE provider_workspace_archived_admissions SET request_message_id = 'other'`,
      ))._tag === "Failure",
    );
    assert.isTrue(
      (yield* Effect.result(
        sql`UPDATE provider_workspace_location_lineage SET new_location = '/other'`,
      ))._tag === "Failure",
    );
    const rows = yield* sql`SELECT recovery_json FROM provider_workspace_binding_archives`;
    assert.deepEqual(rows, [{ recovery_json: '{"retained":true}' }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
