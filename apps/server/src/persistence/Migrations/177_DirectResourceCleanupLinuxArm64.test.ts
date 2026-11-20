import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  at,
  seedAttempt,
  seedPlan,
} from "./129_RepairDirectResourceCleanupRequests.test.helpers.ts";
import { DIRECT_CLEANUP_PLAN_CHILD_TABLES } from "./177_DirectResourceCleanupLinuxArm64.ts";

const MIGRATION_ID = 177;

const insertPlan = (sql: SqlClient.SqlClient, id: string, platform: string) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO direct_resource_cleanup_intents (
      intent_id, event_id, source_command_id, source_payload_digest_version, source_payload_digest,
      entity_kind, entity_id, deletion_mode, deletion_requested_at
    ) VALUES (${id}, ${id}, ${id}, 'v1', 'digest', 'thread', ${id}, 'subtree', ${at})`;
    yield* sql`INSERT INTO direct_resource_cleanup_plans (
      operation_id, intent_id, finalize_command_id, finalize_payload_json,
      finalize_payload_digest_version, finalize_payload_digest, plan_digest, expected_platform,
      state, created_at, updated_at
    ) VALUES (${id}, ${id}, ${id}, '{}', 'v1', 'digest', 'plan', ${platform}, 'prepared', ${at}, ${at})`;
  });

const schemaObjects = (sql: SqlClient.SqlClient) =>
  sql<{ readonly type: string; readonly name: string }>`SELECT type, name FROM sqlite_master
    WHERE name LIKE 'direct_resource_cleanup%' OR tbl_name LIKE 'direct_resource_cleanup%'
    ORDER BY type, name`;

it.effect("admits linux/arm64 cleanup plans and preserves existing plans and children", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: MIGRATION_ID - 1 });
    yield* seedPlan(sql, "existing", "ready");
    yield* seedAttempt(sql, "existing");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(insertPlan(sql, "before", "linux/arm64"))));
    const objectsBefore = yield* schemaObjects(sql);
    const childRowsBefore = yield* Effect.forEach(DIRECT_CLEANUP_PLAN_CHILD_TABLES, (table) =>
      sql.unsafe(`SELECT * FROM ${table}`),
    );
    const planBefore = yield* sql`SELECT * FROM direct_resource_cleanup_plans`;

    assert.deepEqual(
      (yield* runMigrations()).filter(([id]) => id === MIGRATION_ID),
      [[MIGRATION_ID, "DirectResourceCleanupLinuxArm64"]],
    );

    assert.deepEqual(yield* sql`SELECT * FROM direct_resource_cleanup_plans`, planBefore);
    assert.deepEqual(
      yield* Effect.forEach(DIRECT_CLEANUP_PLAN_CHILD_TABLES, (table) =>
        sql.unsafe(`SELECT * FROM ${table}`),
      ),
      childRowsBefore,
    );
    assert.deepEqual(yield* schemaObjects(sql), objectsBefore);
    yield* insertPlan(sql, "arm64", "linux/arm64");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(insertPlan(sql, "ia32", "linux/ia32"))));
    // Guard triggers survived the rebuild: plan identity stays immutable.
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          sql`UPDATE direct_resource_cleanup_plans SET expected_platform = 'linux/x64'
            WHERE operation_id = 'arm64'`,
        ),
      ),
    );
    assert.deepEqual(yield* runMigrations(), []);
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
