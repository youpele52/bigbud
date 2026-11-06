import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("registered147→148 is additive and once-only, preserving runtime/workspace state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 147 });
    const runtime = yield* sql`SELECT * FROM thread_organization_runtime`;
    const workspace = yield* sql`PRAGMA table_info(project_workspace_native_operations)`;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
      runtime_mode, interaction_mode, created_at, updated_at, organization_revision,
      organization_changed_at) VALUES ('old', 'p', 'old', '{}', 'full-access', 'default',
      '2026-10-01', '2026-10-01', 2, '2026-11-05')`;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 148 }), [
      [148, "ThreadOrganizationAging"],
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM thread_organization_runtime`, runtime);
    assert.deepEqual(yield* sql`PRAGMA table_info(project_workspace_native_operations)`, workspace);
    assert.deepEqual(
      yield* sql`SELECT organization_activity_at, organization_age_provenance FROM projection_threads`,
      [{ organization_activity_at: null, organization_age_provenance: "pending" }],
    );
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 148 }), []);
    assert.equal((yield* sql`SELECT * FROM projection_organization_age_backfill`).length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
