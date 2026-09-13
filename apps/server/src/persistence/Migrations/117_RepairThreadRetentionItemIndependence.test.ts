import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import repair from "./117_RepairThreadRetentionItemIndependence.ts";
import {
  seedLegacyRetentionItem,
  seedLegacyRetentionRun,
  seedLegacyRetentionSchema,
} from "./117_RepairThreadRetentionItemIndependence.test.helpers.ts";

it.effect(
  "retention repair preserves tracking through thread deletion and keeps run ownership",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacyRetentionSchema;
      yield* seedLegacyRetentionRun("active");
      yield* seedLegacyRetentionItem("active", "before-repair", "deletion_requested");
      yield* seedLegacyRetentionItem("active", "after-repair", "deletion_requested");
      const artifacts = yield* sql`
      SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') AND sql IS NOT NULL
        AND (tbl_name = 'thread_retention_run_items' OR sql LIKE '%thread_retention_run_items%')
      ORDER BY name
    `;

      // Reproduce the installed schema's loss, then migrate without restoring history.
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'before-repair'`;
      assert.deepEqual(yield* sql`SELECT thread_id FROM thread_retention_run_items`, [
        { thread_id: "after-repair" },
      ]);
      yield* runMigrations();
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'after-repair'`;
      assert.deepEqual(yield* sql`SELECT thread_id, status FROM thread_retention_run_items`, [
        { thread_id: "after-repair", status: "deletion_requested" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT failed_count, completed_count, last_error_code FROM thread_retention_runs`,
        [{ failed_count: 1, completed_count: 0, last_error_code: "retention_items_missing" }],
      );
      assert.deepEqual(
        yield* sql`
      SELECT name, sql FROM sqlite_master WHERE type IN ('trigger', 'index') AND sql IS NOT NULL
        AND (tbl_name = 'thread_retention_run_items' OR sql LIKE '%thread_retention_run_items%')
      ORDER BY name
    `,
        artifacts,
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(sql`
      UPDATE thread_retention_run_items SET status = 'completed' WHERE thread_id = 'after-repair'
    `),
        ),
      );
      assert.deepEqual(yield* runMigrations(), []);
      yield* sql.withTransaction(repair);
      assert.deepEqual(yield* sql`SELECT failed_count FROM thread_retention_runs`, [
        { failed_count: 1 },
      ]);
      yield* sql`DELETE FROM thread_retention_runs WHERE run_id = 'active'`;
      assert.deepEqual(yield* sql`SELECT * FROM thread_retention_run_items`, []);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("retention repair rolls back with its transaction and can retry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedLegacyRetentionSchema;
    yield* seedLegacyRetentionRun("active");
    yield* seedLegacyRetentionItem("active", "preserved");
    const before =
      yield* sql`SELECT sql FROM sqlite_master WHERE name = 'thread_retention_run_items'`;
    const exit = yield* Effect.exit(
      sql.withTransaction(
        repair.pipe(Effect.andThen(Effect.fail(new Error("interrupt migration")))),
      ),
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(
      yield* sql`SELECT sql FROM sqlite_master WHERE name = 'thread_retention_run_items'`,
      before,
    );
    assert.deepEqual(yield* sql`SELECT thread_id FROM thread_retention_run_items`, [
      { thread_id: "preserved" },
    ]);
    yield* runMigrations();
    assert.deepEqual(
      yield* sql`SELECT "table" FROM pragma_foreign_key_list('thread_retention_run_items')`,
      [{ table: "thread_retention_runs" }],
    );
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
