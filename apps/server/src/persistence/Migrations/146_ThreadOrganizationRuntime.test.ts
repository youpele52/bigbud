import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { PROJECTION_BASELINE_REQUIRED_TABLES } from "../ProjectionBaselineSchema.ts";

it.effect(
  "upgrades a fresh145 database exactly once, preserving workspace columns and opt-in safety",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 145 });
      const before = yield* sql`PRAGMA table_info(projection_projects)`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 146 }), [
        [146, "ThreadOrganizationRuntime"],
      ]);
      assert.deepEqual(yield* sql`PRAGMA table_info(projection_projects)`, before);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 146 }), []);
      const rows = yield* sql`SELECT * FROM thread_organization_runtime`;
      assert.deepEqual(rows, [
        {
          singleton: 1,
          policy_version: 0,
          policy_fingerprint: "",
          short_fingerprint: "",
          older_fingerprint: "",
          target_fingerprint: "",
          short_policy_changed_at_ms: null,
          older_policy_changed_at_ms: null,
          target_drain_not_before_ms: null,
          onboarding_decision: "existing-opt-in",
          onboarding_version: 1,
          canonical_frontier: 0,
        },
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM thread_organization_runtime_threads`, []);
      for (const name of ["thread_organization_runtime", "thread_organization_runtime_threads"])
        assert.equal(
          (PROJECTION_BASELINE_REQUIRED_TABLES as readonly string[]).includes(name),
          false,
        );
      const foreignKeys = yield* sql`PRAGMA foreign_key_list(thread_organization_runtime_threads)`;
      assert.deepEqual(foreignKeys, []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("fresh146 migration is transactional and rejects invalid singleton/version state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 146 });
    assert.equal(
      yield* sql`INSERT INTO thread_organization_runtime (singleton) VALUES (2)`.pipe(
        Effect.isFailure,
      ),
      true,
    );
    assert.equal(
      yield* sql`UPDATE thread_organization_runtime SET policy_version = -1`.pipe(Effect.isFailure),
      true,
    );
    assert.equal(
      yield* sql`UPDATE thread_organization_runtime SET onboarding_decision = 'enabled'`.pipe(
        Effect.isFailure,
      ),
      true,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
